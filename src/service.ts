import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { storageFile } from "./auth/session.js";
import type { Config } from "./config.js";
import type { GitHub } from "./github/client.js";
import { verifyGithubSignature } from "./github/signature.js";
import { parseWebhook, type ReviewCommand } from "./github/webhook.js";
import { log } from "./log.js";
import { readBaseDureview, type RepoCheckout } from "./review/checkout.js";
import { ReviewLog, type ReviewLogEntry } from "./review/history.js";
import { createReviewRuntime, enqueueReview, type EnqueueMode, type EnqueueResult, type ReviewHooks, type ReviewResult } from "./review/task.js";
import { permissionAllowsCommand, shouldReviewPull, type PullReviewAction } from "./review/trigger.js";
import type { ReviewRequest } from "./types.js";

export type ServiceOptions = {
  config: Config;
  models: Models;
  github: GitHub;
  checkout: RepoCheckout;
  provider: string;
  modelId: string;
  hooks?: ReviewHooks;
};

export type WebhookResponse = { status: number; body: Record<string, unknown> };

export class DureviewService {
  private constructor(
    readonly harness: Harness,
    private readonly rootId: ConversationId,
    private readonly task: ReturnType<typeof createReviewRuntime>["task"],
    private readonly config: Config,
    private readonly github: GitHub,
    private readonly reviews: ReviewLog,
  ) {}

  static async open(options: ServiceOptions): Promise<DureviewService> {
    await mkdir(options.config.dataDir, { recursive: true, mode: 0o700 });
    const reviews = new ReviewLog(join(options.config.dataDir, "reviews.json"));
    const { extension, task } = createReviewRuntime({
      checkout: options.checkout,
      github: options.github,
      provider: options.provider,
      modelId: options.modelId,
      thinking: options.config.thinking,
      hooks: options.hooks,
      onFinished: (event) => reviews.finish(event),
    });
    const registry = createRegistry();
    registry.install(extension);
    const harness = await Harness.open(
      await openNodeSqliteStorage(storageFile(options.config)),
      {
        models: options.models,
        registry,
        settings: {
          extensions: [extension],
          toolExecution: "sequential",
          compaction: { enabled: false },
          retry: { maxRetries: 2 },
        },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.config.dataDir }),
        onReport: (error) => {
          log("error", "durable task error", { error: error instanceof Error ? error.message : String(error) });
        },
      },
      BACKGROUND_CONTEXT,
    );
    const root = await harness.root(BACKGROUND_CONTEXT);
    harness.resume();
    return new DureviewService(harness, root.id, task, options.config, options.github, reviews);
  }

  async enqueue(request: ReviewRequest, mode: EnqueueMode = { kind: "sha" }, trigger = "unknown"): Promise<EnqueueResult> {
    const root = await this.harness.conversation(this.rootId, BACKGROUND_CONTEXT);
    if (!root) throw new Error("Root conversation is missing.");
    const result = await enqueueReview(root, this.task, request, BACKGROUND_CONTEXT, mode);
    if (!result.deduped && !result.onceSkipped) {
      try {
        await this.reviews.start({
          taskId: String(result.taskId),
          owner: request.owner,
          repo: request.repo,
          number: request.number,
          trigger,
        });
      } catch (error) {
        log("error", "could not record review", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const message = result.onceSkipped
      ? "skipped once-mode review"
      : result.deduped
        ? "skipped duplicate head"
        : "enqueued review";
    log("info", message, {
      repo: `${request.owner}/${request.repo}`,
      pr: request.number,
      sha: request.sha,
      taskId: String(result.taskId),
    });
    return result;
  }

  /** Newest reviews first. Empty when the log is missing or unreadable. */
  recentReviews(): Promise<ReviewLogEntry[]> {
    return this.reviews.list();
  }

  async wait(taskId: TaskId<ReviewResult>) {
    return this.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  }

  async handleWebhook(raw: Buffer, signature: string | undefined, event: string | undefined): Promise<WebhookResponse> {
    if (!this.config.webhookSecret) {
      return { status: 500, body: { error: "webhook secret is not configured" } };
    }
    if (!verifyGithubSignature(raw, signature, this.config.webhookSecret)) {
      return { status: 401, body: { error: "invalid signature" } };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }
    const parsed = parseWebhook(event, payload);
    if (parsed.kind === "ping") return { status: 200, body: { ok: true } };
    if (parsed.kind === "ignore") return { status: 200, body: { ignored: true, reason: parsed.reason } };
    if (parsed.kind === "command") return this.#command(parsed.command);
    return this.#pullRequest(parsed.request, parsed.action);
  }

  /**
   * `.dureview.md` comes from the base branch. A pull request cannot change `trigger` or `drafts`.
   * The review task reads that same ref again for thresholds and prompt rules.
   */
  async #pullRequest(request: ReviewRequest, action: PullReviewAction): Promise<WebhookResponse> {
    const signal = AbortSignal.timeout(20_000);
    let policy;
    try {
      policy = (await readBaseDureview(this.github, request, signal)).policy;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "invalid base .dureview.md", {
        repo: `${request.owner}/${request.repo}`,
        pr: request.number,
        ref: request.baseRef,
        error: message,
      });
      return { status: 200, body: { ignored: true, reason: "config" } };
    }
    const decision = shouldReviewPull({
      action,
      draft: request.draft,
      trigger: policy.trigger,
      drafts: policy.drafts,
      forceSkipDrafts: this.config.skipDrafts,
    });
    if (!decision.review) {
      log("info", "skipped pull request", {
        repo: `${request.owner}/${request.repo}`,
        pr: request.number,
        action,
        reason: decision.reason,
      });
      return { status: 200, body: { ignored: true, reason: decision.reason } };
    }
    const queued = await this.enqueue(request, decision.once ? { kind: "once" } : { kind: "sha" }, action);
    if (queued.onceSkipped) {
      log("info", "skipped pull request", {
        repo: `${request.owner}/${request.repo}`,
        pr: request.number,
        action,
        reason: "once",
      });
      return { status: 200, body: { ignored: true, reason: "once" } };
    }
    return { status: 202, body: { taskId: queued.taskId, deduped: queued.deduped } };
  }

  /** `/dureview` reviews the current head even when trigger or drafts would skip the event. */
  async #command(command: ReviewCommand): Promise<WebhookResponse> {
    const signal = AbortSignal.timeout(20_000);
    const repo = { owner: command.owner, repo: command.repo, installationId: command.installationId };
    const viewer = await this.github.viewerLogin(signal);
    if (viewer.toLowerCase() === command.user.toLowerCase()) {
      return { status: 200, body: { ignored: true, reason: "self" } };
    }
    const permission = await this.github.collaboratorPermission(repo, command.user, signal);
    if (!permissionAllowsCommand(permission)) {
      log("info", "ignored /dureview without write permission", {
        repo: `${command.owner}/${command.repo}`,
        pr: command.number,
        user: command.user,
        permission,
      });
      return { status: 200, body: { ignored: true, reason: "permission" } };
    }
    const pull = await this.github.getPull(repo, command.number, signal);
    const request: ReviewRequest = {
      owner: command.owner,
      repo: command.repo,
      number: command.number,
      sha: pull.sha,
      baseSha: pull.baseSha,
      baseRef: pull.baseRef,
      title: pull.title,
      cloneUrl: command.cloneUrl,
      installationId: command.installationId,
      draft: pull.draft,
    };
    await this.github.reactToComment(repo, command.commentId, signal);
    const queued = await this.enqueue(request, { kind: "command", commentId: command.commentId }, "command");
    log("info", queued.deduped ? "skipped duplicate /dureview" : "enqueued /dureview", {
      repo: `${request.owner}/${request.repo}`,
      pr: request.number,
      sha: request.sha,
      comment: command.commentId,
      taskId: String(queued.taskId),
    });
    return { status: 202, body: { taskId: queued.taskId, deduped: queued.deduped } };
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT);
  }
}
