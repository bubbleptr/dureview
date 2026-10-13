import type { Context } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  configure,
  defineExtension,
  defineTask,
  section,
  type Conversation,
  type ConversationId,
  type Extension,
  type Task,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { GitHub } from "../github/client.js";
import { publishReview, type PublishResult } from "../github/publish.js";
import { log } from "../log.js";
import { commandReviewKey, pullOnceKey, reviewKey, type ReviewRequest } from "../types.js";
import {
  beginReviewCheck,
  CheckUpdateError,
  findOwnCheckRun,
  finishReviewCheck,
  reviewCheckCancelled,
  reviewCheckError,
  reviewCheckOutcome,
  type ReviewCheckOutput,
} from "./checks.js";
import type { RepoCheckout } from "./checkout.js";
import { ReviewConfigError, type ReviewLanguage, type ReviewPolicy } from "./policy.js";
import type { ReviewFinished } from "./history.js";
import { buildUserPrompt, ADVERSARIAL_ROLE } from "./prompt.js";
import type { ReviewSubmission } from "./schema.js";
import { ReviewDraft, ReviewIndex } from "./state.js";
import { reviewTools } from "./tools.js";

export type ReviewHooks = {
  /** Test hook. Runs after generation and before any GitHub write. */
  beforePost?: (context: Context) => Promise<void>;
  /** Test hook. Runs after GitHub has accepted the writes and before the task is marked complete. */
  afterRemoteWrite?: (context: Context) => Promise<void>;
  /** Test hook. Runs after a new check run is created and before that id is checkpointed. */
  afterCheckCreated?: (context: Context) => Promise<void>;
};

export type ReviewDeps = {
  checkout: RepoCheckout;
  github: GitHub;
  provider: string;
  modelId: string;
  thinking: ModelThinkingLevel;
  hooks?: ReviewHooks;
  /** Records a terminal outcome for the status page. Failures here do not fail the review. */
  onFinished?: (event: ReviewFinished) => Promise<void>;
};

type Prepared = {
  conversationId: number;
  checkoutDir: string;
  diff: string;
  rules: string | null;
  policy: ReviewPolicy;
  provider: string;
  modelId: string;
  truncated: boolean;
};

type CheckCheckpoint = {
  /** Set once a check run exists. Absent until then, including after a transient failure. */
  checkRunId?: number;
  /** The App returned 403. Later phases must not try the Checks API again. */
  checksSkipped?: boolean;
  /** A transient Checks API failure. The next phase tries again and looks up `external_id`. */
  checkRetry?: boolean;
  /** Publish result, recorded before the check is completed so a later commit cannot flip it. */
  published?: PublishResult;
  /** Conclusion already chosen for the check. Completing the check retries this output. */
  checkOutput?: ReviewCheckOutput;
};

export type ReviewState =
  | ({ phase: "prepare" } & CheckCheckpoint)
  | ({ phase: "review"; review?: undefined } & CheckCheckpoint & Prepared)
  | ({ phase: "post"; review: ReviewSubmission } & CheckCheckpoint & Prepared);

export type ReviewResult = PublishResult & { conversationId: number };

export type ReviewTask = Task<ReviewRequest, ReviewState, ReviewResult, object>;

export type EnqueueResult = {
  taskId: TaskId<ReviewResult>;
  deduped: boolean;
  /** Set when `trigger: once` already has a running or completed review for this pull request. */
  onceSkipped?: boolean;
};

export type EnqueueMode =
  | { kind: "sha" }
  | { kind: "once" }
  | { kind: "command"; commentId: number };

export function createReviewRuntime(deps: ReviewDeps): { extension: Extension; task: ReviewTask } {
  let extension!: Extension;
  const task = defineTask<ReviewRequest, ReviewState, ReviewResult>({
    name: "dureview.review",
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async (current, runtime, context) => {
        const signal = signalOf(context);
        const request = current.input;
        let language: ReviewLanguage = "en";
        let slot = slotFrom(current.state.checkpoint);
        const fail = (error: unknown) =>
          failOrAbort(
            runtime,
            context,
            error,
            {
              github: deps.github,
              request,
              checkRunId: slotId(slot),
              language,
              signal,
            },
            () => notifyFinished(deps, failedEvent(current)),
          );
        try {
          if (slot.kind === "missing" || slot.kind === "retry") {
            const begun = await beginReviewCheck(deps.github, request, String(current.id), language, signal);
            if (context.abortSignal?.aborted) throw new Error("aborted");
            if (begun.status === "open" && begun.created && deps.hooks?.afterCheckCreated) {
              await deps.hooks.afterCheckCreated(context);
            }
            if (context.abortSignal?.aborted) throw new Error("aborted");
            if (begun.status === "open") {
              slot = { kind: "open", checkRunId: begun.id };
              await runtime.commit(
                () => ({ status: "running", checkpoint: { phase: "prepare", ...checkFields(slot) } }),
                context,
              );
              return;
            }
            if (begun.status === "skipped") {
              slot = { kind: "skipped" };
              await runtime.commit(
                () => ({ status: "running", checkpoint: { phase: "prepare", checksSkipped: true } }),
                context,
              );
              return;
            }
            if (slot.kind !== "retry") {
              await runtime.commit(
                () => ({ status: "running", checkpoint: { phase: "prepare", checkRetry: true } }),
                context,
              );
              return;
            }
            slot = { kind: "retry" };
          }
          const prepared = await deps.checkout.prepare(request, signal);
          language = prepared.policy.language;
          const model = runtime.models.getModel(deps.provider, deps.modelId);
          if (!model) {
            await fail(new ReviewConfigError(`Unknown model ${deps.provider}/${deps.modelId}.`));
            return;
          }
          await runtime.commit(async (tx) => {
            const created = await tx.createConversation({
              ownership: { kind: "task", taskId: current.id },
            });
            await configure(tx, created.id, {
              model: { provider: deps.provider, modelId: deps.modelId },
              thinkingLevel: deps.thinking,
              extensions: [extension],
              tools: [...reviewTools],
              cwd: prepared.dir,
            });
            const checkpoint: ReviewState = {
              phase: "review",
              ...checkFields(slot),
              conversationId: created.id,
              checkoutDir: prepared.dir,
              diff: prepared.diff,
              rules: prepared.rules,
              policy: prepared.policy,
              provider: deps.provider,
              modelId: deps.modelId,
              truncated: prepared.truncated,
            };
            return { status: "running", checkpoint };
          }, context);
        } catch (error) {
          if (context.abortSignal?.aborted) throw error instanceof Error ? error : new Error(String(error));
          await fail(error);
        }
      },
      review: async (current, runtime, context) => {
        const signal = signalOf(context);
        const checkpoint = current.state.checkpoint;
        const slot = await resolveCheck(deps.github, current.input, String(current.id), checkpoint.policy.language, checkpoint, signal);
        const fail = (error: unknown) =>
          failOrAbort(
            runtime,
            context,
            error,
            {
              github: deps.github,
              request: current.input,
              checkRunId: slotId(slot),
              language: checkpoint.policy.language,
              signal,
            },
            () => notifyFinished(deps, failedEvent(current)),
          );
        try {
          const conversationId = checkpoint.conversationId as ConversationId;
          const conversation = await runtime.conversation(conversationId, context);
          if (!conversation) {
            await fail("Review conversation is missing.");
            return;
          }
          const prompt = buildUserPrompt({
            request: current.input,
            diff: checkpoint.diff,
            truncated: checkpoint.truncated,
            rules: checkpoint.rules,
            policy: checkpoint.policy,
          });
          const first = await conversation.submit(
            { type: "input", content: prompt, requestId: `dureview:${current.id}:prompt` },
            context,
          );
          const firstSettled = await first.wait(context);
          if (firstSettled.status !== "done") {
            await fail(`Review run did not finish: ${firstSettled.reason}`);
            return;
          }
          let draft = await runtime.snapshot(ReviewDraft, conversationId, context);
          if (!draft?.submitted) {
            const nudge = await conversation.submit(
              {
                type: "input",
                content:
                  'Call submit_review now. If nothing is wrong, set verdict to "clean", explain that in verdict_reason, list what you checked, and pass an empty findings array.',
                requestId: `dureview:${current.id}:nudge`,
              },
              context,
            );
            const nudged = await nudge.wait(context);
            if (nudged.status !== "done") {
              await fail(`Review nudge did not finish: ${nudged.reason}`);
              return;
            }
            draft = await runtime.snapshot(ReviewDraft, conversationId, context);
          }
          if (!draft?.submitted) {
            await fail("The model finished without calling submit_review.");
            return;
          }
          const review: ReviewSubmission = {
            verdict: draft.verdict,
            verdictReason: draft.verdictReason,
            overallConfidence: draft.overallConfidence,
            checked: [...draft.checked],
            findings: draft.findings.map((finding) => ({
              ...finding,
              evidence: [...finding.evidence],
            })),
          };
          const next: ReviewState = { ...checkpoint, phase: "post", ...checkFields(slot), review };
          await runtime.commit(() => ({ status: "running", checkpoint: next }), context);
        } catch (error) {
          if (context.abortSignal?.aborted) throw error instanceof Error ? error : new Error(String(error));
          await fail(error);
        }
      },
      post: async (current, runtime, context) => {
        const signal = signalOf(context);
        const checkpoint = current.state.checkpoint;
        const slot = await resolveCheck(
          deps.github,
          current.input,
          String(current.id),
          checkpoint.policy.language,
          checkpoint,
          signal,
        );
        const fail = (error: unknown) =>
          failOrAbort(
            runtime,
            context,
            error,
            {
              github: deps.github,
              request: current.input,
              checkRunId: slotId(slot),
              language: checkpoint.policy.language,
              signal,
            },
            () => notifyFinished(deps, failedEvent(current)),
          );
        let checkCompleted = false;
        try {
          let published = checkpoint.published;
          let checkOutput = checkpoint.checkOutput;
          if (!published || !checkOutput) {
            if (deps.hooks?.beforePost) await deps.hooks.beforePost(context);
            published = await publishReview({
              github: deps.github,
              request: current.input,
              taskId: String(current.id),
              provider: checkpoint.provider,
              modelId: checkpoint.modelId,
              review: checkpoint.review,
              policy: checkpoint.policy,
              diff: checkpoint.diff,
              signal,
              afterRemoteWrite: deps.hooks?.afterRemoteWrite
                ? async () => {
                    await deps.hooks?.afterRemoteWrite?.(context);
                  }
                : undefined,
            });
            checkOutput = reviewCheckOutcome({
              findings: checkpoint.review.findings,
              diff: checkpoint.diff,
              policy: checkpoint.policy,
            });
            // Record the publish before the check is completed. A commit failure here
            // has not written success, so it cannot be rewritten into a failure.
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: { ...checkpoint, phase: "post", ...checkFields(slot), published, checkOutput },
              }),
              context,
            );
            return;
          }
          await finishReviewCheck(
            deps.github,
            current.input,
            slotId(slot),
            checkOutput,
            signal,
            slotId(slot) === null
              ? undefined
              : { taskId: String(current.id), language: checkpoint.policy.language },
          );
          checkCompleted = true;
          log("info", "posted review", {
            repo: `${current.input.owner}/${current.input.repo}`,
            pr: current.input.number,
            sha: current.input.sha,
            taskId: String(current.id),
            summaryAction: published.summaryAction,
            reviewAction: published.reviewAction,
          });
          await notifyFinished(deps, {
            taskId: String(current.id),
            owner: current.input.owner,
            repo: current.input.repo,
            number: current.input.number,
            outcome: "completed",
            verdict: checkpoint.review.verdict,
            findingCount: checkpoint.review.findings.length,
          });
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "completed",
                result: { ...published, conversationId: checkpoint.conversationId },
              },
            }),
            context,
          );
        } catch (error) {
          if (context.abortSignal?.aborted) throw error instanceof Error ? error : new Error(String(error));
          if (error instanceof CheckUpdateError) {
            log("error", "could not update the dureview check run", { error: error.message });
            await notifyFinished(deps, failedEvent(current));
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "failed", error: { message: error.message } } }),
              context,
            );
            return;
          }
          const published = checkpoint.published;
          if (checkCompleted && published) {
            await runtime.commit(
              () => ({
                status: "terminal",
                outcome: {
                  status: "completed",
                  result: { ...published, conversationId: checkpoint.conversationId },
                },
              }),
              context,
            );
            return;
          }
          await fail(error);
        }
      },
    },
    abort: async (current, runtime, context) => {
      const signal = signalOf(context);
      const checkpoint = current.state.checkpoint;
      if (checkpoint.checksSkipped !== true) {
        try {
          const id = await findOwnCheckRun(
            deps.github,
            current.input,
            String(current.id),
            typeof checkpoint.checkRunId === "number" ? checkpoint.checkRunId : null,
            signal,
          );
          if (id !== null) {
            await finishReviewCheck(
              deps.github,
              current.input,
              id,
              reviewCheckCancelled(languageOf(checkpoint)),
              signal,
            );
          }
        } catch (error) {
          log("error", "could not finish the dureview check run after abort", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  extension = defineExtension({
    name: "dureview",
    tools: reviewTools,
    sections: [section("role", () => ADVERSARIAL_ROLE, { tag: false })],
    tasks: [task],
  });
  return { extension, task };
}

/**
 * Create one review task per pull request head. A second enqueue of the same SHA
 * returns the existing task while it is running or after it completed.
 * A failed task can be replaced so a later delivery can try again.
 *
 * `once` claims a single automatic review for the pull request and ignores later events.
 * `command` uses a key of (sha, comment id), so it bypasses the head SHA dedupe, and it
 * claims the once-mode slot when that slot is still open.
 */
export function enqueueReview(
  root: Conversation,
  task: ReviewTask,
  request: ReviewRequest,
  context: Context,
  mode: EnqueueMode = { kind: "sha" },
): Promise<EnqueueResult> {
  const key = mode.kind === "command" ? commandReviewKey(request, mode.commentId) : reviewKey(request);
  const onceKey = pullOnceKey(request);
  return root.commit(async (tx) => {
    const index = await tx.doc(ReviewIndex);
    let claimOnce = mode.kind === "once" || mode.kind === "command";
    if (claimOnce) {
      const priorId = index.onceByPull[onceKey];
      if (priorId !== undefined && (await taskCounts(tx, priorId))) {
        if (mode.kind === "once") {
          return { taskId: priorId as TaskId<ReviewResult>, deduped: true, onceSkipped: true };
        }
        claimOnce = false;
      }
    }
    const existingId = index.byKey[key];
    if (existingId !== undefined) {
      const existing = await tx.task(existingId as TaskId<ReviewResult>);
      const running = existing !== undefined && existing.state.status !== "terminal";
      const completed =
        existing !== undefined &&
        existing.state.status === "terminal" &&
        existing.state.outcome.status === "completed";
      if (running || completed) {
        return { taskId: existingId as TaskId<ReviewResult>, deduped: true };
      }
    }
    const taskId = (await tx.createTask(task, request, {
      ownership: { kind: "conversation" },
    })) as TaskId<ReviewResult>;
    index.byKey[key] = taskId;
    if (claimOnce) index.onceByPull[onceKey] = taskId;
    return { taskId, deduped: false };
  }, context);
}

type IndexTransaction = Parameters<Parameters<Conversation["commit"]>[0]>[0];

/** A running or completed task still occupies the once-mode slot. A failed task does not. */
async function taskCounts(tx: IndexTransaction, taskId: number): Promise<boolean> {
  const existing = await tx.task(taskId as TaskId<ReviewResult>);
  if (existing === undefined) return false;
  if (existing.state.status !== "terminal") return true;
  return existing.state.outcome.status === "completed";
}

type TaskRuntime = Parameters<ReviewTask["definition"]["phases"]["prepare"]>[1];

type CheckSlot =
  | { kind: "missing" }
  | { kind: "skipped" }
  | { kind: "retry" }
  | { kind: "open"; checkRunId: number };

/**
 * Open the check, or reuse one this task already created (`external_id`).
 * A stored skip is only the 403 case. `retry` means a transient failure and is tried again.
 */
async function resolveCheck(
  github: GitHub,
  request: ReviewRequest,
  taskId: string,
  language: ReviewLanguage,
  checkpoint: ReviewState,
  signal: AbortSignal,
): Promise<CheckSlot> {
  const stored = slotFrom(checkpoint);
  if (stored.kind === "skipped" || stored.kind === "open") return stored;
  const begun = await beginReviewCheck(github, request, taskId, language, signal);
  if (begun.status === "open") return { kind: "open", checkRunId: begun.id };
  if (begun.status === "skipped") return { kind: "skipped" };
  return { kind: "retry" };
}

function slotFrom(checkpoint: ReviewState): CheckSlot {
  if (checkpoint.checksSkipped === true) return { kind: "skipped" };
  if (typeof checkpoint.checkRunId === "number") return { kind: "open", checkRunId: checkpoint.checkRunId };
  if (checkpoint.checkRetry === true) return { kind: "retry" };
  return { kind: "missing" };
}

function slotId(slot: CheckSlot): number | null {
  return slot.kind === "open" ? slot.checkRunId : null;
}

function checkFields(slot: CheckSlot): { checkRunId?: number; checksSkipped?: true; checkRetry?: true } {
  if (slot.kind === "skipped") return { checksSkipped: true };
  if (slot.kind === "open") return { checkRunId: slot.checkRunId };
  if (slot.kind === "retry") return { checkRetry: true };
  return {};
}

function languageOf(checkpoint: ReviewState): ReviewLanguage {
  return checkpoint.phase === "prepare" ? "en" : checkpoint.policy.language;
}

/**
 * Record a terminal failure. Shutdown aborts the invocation while the scheduler is already
 * closing, so the error is rethrown and the checkpoint stays put for the next process.
 * The check run is completed first so it does not stay in progress, unless this process
 * is shutting down and the review will resume.
 */
async function failOrAbort(
  runtime: TaskRuntime,
  context: Context,
  error: unknown,
  check: {
    github: GitHub;
    request: ReviewRequest;
    checkRunId: number | null;
    language: ReviewLanguage;
    signal: AbortSignal;
  },
  onFailed?: () => Promise<void>,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (context.abortSignal?.aborted) throw error instanceof Error ? error : new Error(message);
  try {
    await finishReviewCheck(
      check.github,
      check.request,
      check.checkRunId,
      reviewCheckError(error, check.language),
      check.signal,
    );
  } catch (updateError) {
    if (context.abortSignal?.aborted) throw updateError instanceof Error ? updateError : new Error(String(updateError));
    log("error", "could not update the dureview check run", {
      error: updateError instanceof Error ? updateError.message : String(updateError),
    });
  }
  if (context.abortSignal?.aborted) throw new Error(message);
  log("error", "review failed", { error: message });
  if (onFailed) await onFailed();
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
    context,
  );
}

async function notifyFinished(deps: ReviewDeps, event: ReviewFinished): Promise<void> {
  if (!deps.onFinished) return;
  try {
    await deps.onFinished(event);
  } catch (error) {
    log("error", "could not record review", { error: error instanceof Error ? error.message : String(error) });
  }
}

function failedEvent(current: { id: TaskId<ReviewResult>; input: ReviewRequest }): ReviewFinished {
  return {
    taskId: String(current.id),
    owner: current.input.owner,
    repo: current.input.repo,
    number: current.input.number,
    outcome: "failed",
    verdict: null,
    findingCount: null,
  };
}

function signalOf(context: Context): AbortSignal {
  return context.abortSignal ?? new AbortController().signal;
}
