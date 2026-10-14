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
import type { RepoCheckout } from "./checkout.js";
import type { ReviewPolicy } from "./policy.js";
import { buildUserPrompt, ADVERSARIAL_ROLE } from "./prompt.js";
import type { ReviewFinished } from "./history.js";
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
  | { phase: "prepare" }
  | ({ phase: "review" } & Prepared)
  | ({ phase: "post"; review: ReviewSubmission } & Prepared);

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
  const recordFailure = (
    current: { id: TaskId<ReviewResult>; input: ReviewRequest },
    runtime: TaskRuntime,
    context: Context,
    message: string,
  ) =>
    failOrAbort(runtime, context, message, () =>
      notifyFinished(deps, {
        taskId: String(current.id),
        owner: current.input.owner,
        repo: current.input.repo,
        number: current.input.number,
        outcome: "failed",
        verdict: null,
        findingCount: null,
        error: message,
        title: current.input.title,
        sha: current.input.sha,
        baseSha: current.input.baseSha,
        baseRef: current.input.baseRef,
        installationId: current.input.installationId,
      }),
    );
  const task = defineTask<ReviewRequest, ReviewState, ReviewResult>({
    name: "dureview.review",
    version: 1,
    initial: () => ({ phase: "prepare" }),
    phases: {
      prepare: async (current, runtime, context) => {
        let prepared;
        try {
          prepared = await deps.checkout.prepare(current.input, signalOf(context));
        } catch (error) {
          await recordFailure(current, runtime, context, error instanceof Error ? error.message : String(error));
          return;
        }
        const model = runtime.models.getModel(deps.provider, deps.modelId);
        if (!model) {
          await recordFailure(current, runtime, context, `Unknown model ${deps.provider}/${deps.modelId}.`);
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
      },
      review: async (current, runtime, context) => {
        const checkpoint = current.state.checkpoint;
        const conversationId = checkpoint.conversationId as ConversationId;
        const conversation = await runtime.conversation(conversationId, context);
        if (!conversation) {
          await recordFailure(current, runtime, context, "Review conversation is missing.");
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
          await recordFailure(current, runtime, context, `Review run did not finish: ${firstSettled.reason}`);
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
            await recordFailure(current, runtime, context, `Review nudge did not finish: ${nudged.reason}`);
            return;
          }
          draft = await runtime.snapshot(ReviewDraft, conversationId, context);
        }
        if (!draft?.submitted) {
          await recordFailure(current, runtime, context, "The model finished without calling submit_review.");
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
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              ...checkpoint,
              phase: "post",
              review,
            },
          }),
          context,
        );
      },
      post: async (current, runtime, context) => {
        if (deps.hooks?.beforePost) await deps.hooks.beforePost(context);
        const checkpoint = current.state.checkpoint;
        const published = await publishReview({
          github: deps.github,
          request: current.input,
          taskId: String(current.id),
          provider: checkpoint.provider,
          modelId: checkpoint.modelId,
          review: checkpoint.review,
          policy: checkpoint.policy,
          diff: checkpoint.diff,
          signal: signalOf(context),
          afterRemoteWrite: deps.hooks?.afterRemoteWrite
            ? async () => {
                await deps.hooks?.afterRemoteWrite?.(context);
              }
            : undefined,
        });
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
          title: current.input.title,
          sha: current.input.sha,
          baseSha: current.input.baseSha,
          baseRef: current.input.baseRef,
          installationId: current.input.installationId,
          verdictReason: checkpoint.review.verdictReason,
          overallConfidence: checkpoint.review.overallConfidence,
          checked: checkpoint.review.checked,
          policy: checkpoint.policy,
          findings: checkpoint.review.findings,
          provider: checkpoint.provider,
          modelId: checkpoint.modelId,
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
 * Record a terminal failure. Shutdown aborts the invocation while the scheduler is already
 * closing, so the error is rethrown and the checkpoint stays put for the next process.
 */
async function failOrAbort(
  runtime: TaskRuntime,
  context: Context,
  message: string,
  onFailed?: () => Promise<void>,
): Promise<void> {
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

function signalOf(context: Context): AbortSignal {
  return context.abortSignal ?? new AbortController().signal;
}
