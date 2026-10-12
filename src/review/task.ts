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
import { reviewKey, type Finding, type ReviewRequest } from "../types.js";
import type { RepoCheckout } from "./checkout.js";
import { buildUserPrompt, ADVERSARIAL_ROLE } from "./prompt.js";
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
};

type Prepared = {
  conversationId: number;
  checkoutDir: string;
  diff: string;
  rules: string | null;
  provider: string;
  modelId: string;
  truncated: boolean;
};

export type ReviewState =
  | { phase: "prepare" }
  | ({ phase: "review" } & Prepared)
  | ({ phase: "post"; summary: string; findings: Finding[] } & Prepared);

export type ReviewResult = PublishResult & { conversationId: number };

export type ReviewTask = Task<ReviewRequest, ReviewState, ReviewResult, object>;

export type EnqueueResult = { taskId: TaskId<ReviewResult>; deduped: boolean };

export function createReviewRuntime(deps: ReviewDeps): { extension: Extension; task: ReviewTask } {
  let extension!: Extension;
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
          await fail(runtime, context, error instanceof Error ? error.message : String(error));
          return;
        }
        const model = runtime.models.getModel(deps.provider, deps.modelId);
        if (!model) {
          await fail(runtime, context, `Unknown model ${deps.provider}/${deps.modelId}.`);
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
          await fail(runtime, context, "Review conversation is missing.");
          return;
        }
        const prompt = buildUserPrompt({
          request: current.input,
          diff: checkpoint.diff,
          truncated: checkpoint.truncated,
          rules: checkpoint.rules,
        });
        const first = await conversation.submit(
          { type: "input", content: prompt, requestId: `dureview:${current.id}:prompt` },
          context,
        );
        const firstSettled = await first.wait(context);
        if (firstSettled.status !== "done") {
          await fail(runtime, context, `Review run did not finish: ${firstSettled.reason}`);
          return;
        }
        let draft = await runtime.snapshot(ReviewDraft, conversationId, context);
        if (!draft?.submitted) {
          const nudge = await conversation.submit(
            {
              type: "input",
              content:
                'Call submit_review now. If nothing is wrong, use summary "No findings." and an empty findings array.',
              requestId: `dureview:${current.id}:nudge`,
            },
            context,
          );
          const nudged = await nudge.wait(context);
          if (nudged.status !== "done") {
            await fail(runtime, context, `Review nudge did not finish: ${nudged.reason}`);
            return;
          }
          draft = await runtime.snapshot(ReviewDraft, conversationId, context);
        }
        if (!draft?.submitted) {
          await fail(runtime, context, "The model finished without calling submit_review.");
          return;
        }
        const findings = draft.findings.map((finding) => ({
          path: finding.path,
          line: finding.line,
          body: finding.body,
        }));
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: {
              ...checkpoint,
              phase: "post",
              summary: draft.summary,
              findings,
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
          summary: checkpoint.summary,
          findings: checkpoint.findings,
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
 */
export function enqueueReview(
  root: Conversation,
  task: ReviewTask,
  request: ReviewRequest,
  context: Context,
): Promise<EnqueueResult> {
  const key = reviewKey(request);
  return root.commit(async (tx) => {
    const index = await tx.doc(ReviewIndex);
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
    return { taskId, deduped: false };
  }, context);
}

type TaskRuntime = Parameters<ReviewTask["definition"]["phases"]["prepare"]>[1];

async function fail(runtime: TaskRuntime, context: Context, message: string): Promise<void> {
  log("error", "review failed", { error: message });
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
    context,
  );
}

function signalOf(context: Context): AbortSignal {
  return context.abortSignal ?? new AbortController().signal;
}
