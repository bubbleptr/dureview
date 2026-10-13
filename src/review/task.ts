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
import { beginReviewCheck, finishReviewCheck, reviewCheckError, reviewCheckOutcome } from "./checks.js";
import type { RepoCheckout } from "./checkout.js";
import type { ReviewLanguage, ReviewPolicy } from "./policy.js";
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

export type ReviewState =
  | { phase: "prepare"; checkRunId?: number | null }
  | ({ phase: "review"; checkRunId: number | null } & Prepared)
  | ({ phase: "post"; checkRunId: number | null; review: ReviewSubmission } & Prepared);

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
        const stored = readCheckRunId(current.state.checkpoint);
        let checkRunId = stored ?? null;
        const fail = (message: string) =>
          failOrAbort(
            runtime,
            context,
            message,
            {
              github: deps.github,
              request,
              checkRunId,
              language,
              signal,
            },
            () => notifyFinished(deps, failedEvent(current)),
          );
        try {
          if (stored === undefined) {
            checkRunId = await beginReviewCheck(deps.github, request, String(current.id), signal);
            await runtime.commit(
              () => ({ status: "running", checkpoint: { phase: "prepare", checkRunId } }),
              context,
            );
            return;
          }
          const prepared = await deps.checkout.prepare(request, signal);
          language = prepared.policy.language;
          const model = runtime.models.getModel(deps.provider, deps.modelId);
          if (!model) {
            await fail(`Unknown model ${deps.provider}/${deps.modelId}.`);
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
              checkRunId,
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
          await fail(error instanceof Error ? error.message : String(error));
        }
      },
      review: async (current, runtime, context) => {
        const signal = signalOf(context);
        const checkpoint = current.state.checkpoint;
        const checkRunId = await ensureReviewCheck(
          deps.github,
          current.input,
          String(current.id),
          readCheckRunId(checkpoint),
          signal,
        );
        const fail = (message: string) =>
          failOrAbort(
            runtime,
            context,
            message,
            {
              github: deps.github,
              request: current.input,
              checkRunId,
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
          const next: ReviewState = { ...checkpoint, phase: "post", checkRunId, review };
          await runtime.commit(() => ({ status: "running", checkpoint: next }), context);
        } catch (error) {
          await fail(error instanceof Error ? error.message : String(error));
        }
      },
      post: async (current, runtime, context) => {
        const signal = signalOf(context);
        const checkpoint = current.state.checkpoint;
        const checkRunId = await ensureReviewCheck(
          deps.github,
          current.input,
          String(current.id),
          readCheckRunId(checkpoint),
          signal,
        );
        const fail = (message: string) =>
          failOrAbort(
            runtime,
            context,
            message,
            {
              github: deps.github,
              request: current.input,
              checkRunId,
              language: checkpoint.policy.language,
              signal,
            },
            () => notifyFinished(deps, failedEvent(current)),
          );
        try {
          if (deps.hooks?.beforePost) await deps.hooks.beforePost(context);
          const published = await publishReview({
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
          await finishReviewCheck(
            deps.github,
            current.input,
            checkRunId,
            reviewCheckOutcome({
              findings: checkpoint.review.findings,
              diff: checkpoint.diff,
              policy: checkpoint.policy,
            }),
            signal,
          );
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
          await fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    abort: async (_current, runtime, context) => {
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

/**
 * Open the check once per task. A stored null means an earlier attempt skipped it
 * (the App returned 403, or the Checks API failed) and should not be retried.
 */
async function ensureReviewCheck(
  github: GitHub,
  request: ReviewRequest,
  taskId: string,
  stored: number | null | undefined,
  signal: AbortSignal,
): Promise<number | null> {
  if (stored !== undefined) return stored;
  return beginReviewCheck(github, request, taskId, signal);
}

function readCheckRunId(checkpoint: ReviewState): number | null | undefined {
  if (!("checkRunId" in checkpoint)) return undefined;
  return checkpoint.checkRunId ?? null;
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
  message: string,
  check: {
    github: GitHub;
    request: ReviewRequest;
    checkRunId: number | null;
    language: ReviewLanguage;
    signal: AbortSignal;
  },
  onFailed?: () => Promise<void>,
): Promise<void> {
  if (context.abortSignal?.aborted) throw new Error(message);
  await finishReviewCheck(check.github, check.request, check.checkRunId, reviewCheckError(message, check.language), check.signal);
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
