import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { storageFile } from "./auth/session.js";
import { baselineFromConfig, type Config, type EditableBaseline } from "./config.js";
import { ServerSettings, type EffectiveConfig, type SettingsWriteResult } from "./settings/effective.js";
import type { SettingsFormValues, SettingsPageModel } from "./settings/page.js";
import type { GitHub } from "./github/client.js";
import { verifyGithubSignature } from "./github/signature.js";
import { parseWebhook, type ReviewCommand } from "./github/webhook.js";
import { log } from "./log.js";
import { readBaseDureview, safeRepoPath, type RepoCheckout } from "./review/checkout.js";
import { loadReviewFilePair, matchReviewedFile, type ReviewFileContents } from "./ui/file-contents.js";
import { ReviewArchive, REVIEWS_DB_FILE, type ReviewDetail, type ReviewFilter, type ReviewList } from "./review/archive.js";
import type { StatsQuery, StatsSnapshot } from "./review/stats.js";
import type { PullFile } from "./github/client.js";
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
  /**
   * Environment layer for editable settings. When omitted, every config value is treated as set in the environment.
   * Production passes `editableBaseline()` so an unset variable stays a built-in default.
   */
  baseline?: EditableBaseline;
  /** When omitted, overrides are stored beside the review archive. */
  settings?: ServerSettings;
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
    private readonly archive: ReviewArchive,
    private readonly settings: ServerSettings,
  ) {}

  static async open(options: ServiceOptions): Promise<DureviewService> {
    await mkdir(options.config.dataDir, { recursive: true, mode: 0o700 });
    const reviews = new ReviewLog(join(options.config.dataDir, "reviews.json"));
    const archive = new ReviewArchive(
      join(options.config.dataDir, REVIEWS_DB_FILE),
      join(options.config.dataDir, "reviews.json"),
    );
    await archive.open();
    const settings =
      options.settings ??
      (await ServerSettings.open({
        file: join(options.config.dataDir, REVIEWS_DB_FILE),
        baseline: options.baseline ?? baselineFromConfig(options.config),
        models: options.models,
        provider: options.provider,
      }));
    const { extension, task } = createReviewRuntime({
      checkout: options.checkout,
      github: options.github,
      currentModel: () => {
        const effective = settings.effective();
        return { provider: effective.provider, modelId: effective.modelId, thinking: effective.thinking };
      },
      hooks: options.hooks,
      onFinished: async (event) => {
        try {
          await reviews.finish(event);
        } catch (error) {
          log("error", "could not record review", { error: error instanceof Error ? error.message : String(error) });
        }
        await archive.finish(event);
      },
    });
    const registry = createRegistry();
    registry.install(extension);
    let harness: Harness;
    try {
      harness = await Harness.open(
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
    } catch (error) {
      settings.close();
      archive.close();
      throw error;
    }
    const root = await harness.root(BACKGROUND_CONTEXT);
    harness.resume();
    return new DureviewService(harness, root.id, task, options.config, options.github, reviews, archive, settings);
  }

  /** Model, thinking, trigger, draft skip, and checkout TTL after overrides. */
  effectiveConfig(): EffectiveConfig {
    return this.settings.effective();
  }

  checkoutTtlMs(): number {
    return this.settings.effective().checkoutTtlDays * 24 * 60 * 60 * 1000;
  }

  settingsPage(extra?: { error?: string | null; saved?: boolean }): Promise<SettingsPageModel> {
    return this.settings.page(extra);
  }

  saveSettings(input: SettingsFormValues, actor: string): Promise<SettingsWriteResult> {
    return this.settings.save(input, actor);
  }

  resetSetting(key: string, actor: string): Promise<SettingsWriteResult> {
    return this.settings.reset(key, actor);
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
      try {
        await this.archive.start({
          taskId: String(result.taskId),
          owner: request.owner,
          repo: request.repo,
          number: request.number,
          title: request.title,
          sha: request.sha,
          baseSha: request.baseSha,
          baseRef: request.baseRef,
          installationId: request.installationId,
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

  /** Filtered review rows for the list page. Does not include comment text. */
  reviewsForUi(filter: ReviewFilter): Promise<ReviewList> {
    return this.archive.list(filter);
  }

  /** Aggregated statistics. Finding text is not returned. */
  statsForUi(filter: StatsQuery): Promise<StatsSnapshot> {
    return this.archive.stats(filter);
  }

  /** True when this task is in the archive. Does not call GitHub. */
  reviewExists(taskId: string): Promise<boolean> {
    return this.archive.exists(taskId);
  }

  /** Owner, repo, and head SHA of reviews whose checkout must not be deleted. */
  runningCheckouts(): Promise<Array<{ owner: string; repo: string; sha: string }>> {
    return this.archive.runningCheckouts();
  }

  /**
   * Full old and new text for one changed file in this review's diff.
   * The path must be a pull-request filename, or the previous filename of a rename.
   * Anything else is rejected: 400 for a traversal or a previous path that is not
   * that file's other name, 404 when the task or file is not in the diff.
   * The local checkout is preferred. GitHub is used when that checkout is gone.
   * Binary files, oversized files, and a failed lookup return `unavailable`.
   */
  async reviewFileContents(
    taskId: string,
    filePath: string,
    previousPath: string | null,
    signal: AbortSignal,
  ): Promise<ReviewFileContents | { kind: "rejected"; status: 400 | 404 }> {
    if (!safeRepoPath(filePath) || (previousPath !== null && !safeRepoPath(previousPath))) {
      return { kind: "rejected", status: 400 };
    }
    const review = await this.archive.get(taskId);
    if (!review) return { kind: "rejected", status: 404 };
    const loaded = await this.#pullFiles(review, signal);
    if (loaded.diffUnavailable) return { kind: "rejected", status: 404 };
    const matched = matchReviewedFile(loaded.files, filePath, previousPath);
    if (matched.kind === "rejected") return matched;
    return loadReviewFilePair({
      checkoutRoot: join(this.config.dataDir, "checkouts"),
      github: this.github,
      owner: review.owner,
      repo: review.repo,
      installationId: review.installationId,
      sha: review.sha,
      baseSha: review.baseSha,
      path: matched.path,
      previousPath: matched.previousPath,
      signal,
    });
  }

  /** Saved review row. Does not call GitHub. */
  savedReview(taskId: string): Promise<ReviewDetail | null> {
    return this.archive.get(taskId);
  }

  /**
   * One saved review plus the diff at its head SHA.
   * A finished review reuses the file list stored for that SHA.
   * A running review always asks GitHub, because the pull request can still move.
   * A GitHub error or the detail page's own deadline leaves the saved comments in place.
   * Cancelling the caller's signal still rejects.
   */
  async reviewForUi(
    taskId: string,
    signal: AbortSignal,
  ): Promise<{ review: ReviewDetail; files: PullFile[]; diffUnavailable: boolean } | null> {
    const review = await this.archive.get(taskId);
    if (!review) return null;
    const loaded = await this.#pullFiles(review, signal);
    return { review, files: loaded.files, diffUnavailable: loaded.diffUnavailable };
  }

  async #pullFiles(
    review: ReviewDetail,
    signal: AbortSignal,
  ): Promise<{ files: PullFile[]; diffUnavailable: boolean }> {
    const frozen = review.outcome !== "running" && review.sha.length > 0;
    if (frozen) {
      const cached = await this.archive.readPullSnapshot(review.taskId, review.sha);
      if (cached) return { files: cached, diffUnavailable: false };
    }
    const request = {
      owner: review.owner,
      repo: review.repo,
      number: review.number,
      installationId: review.installationId,
    };
    try {
      const files = frozen
        ? await this.#reviewedFiles(review, signal)
        : await this.github.listPullFiles(request, signal);
      if (frozen) await this.#storePullSnapshot(review, files);
      return { files, diffUnavailable: false };
    } catch (error) {
      if (signal.aborted && !isDeadline(signal, error)) throw error;
      log("error", "could not load pull request diff", {
        repo: `${review.owner}/${review.repo}`,
        pr: review.number,
        error: error instanceof Error ? error.message : String(error),
      });
      return { files: [], diffUnavailable: true };
    }
  }

  /**
   * File list at `review.sha` against `review.baseSha`. The pull-request files API is the
   * live head against the live base, so it is stored only when both are still the reviewed
   * SHAs after the fetch. A moved or retargeted base keeps the head and changes the diff.
   * Otherwise the compare `baseSha...sha` is the diff this review saw.
   */
  async #reviewedFiles(review: ReviewDetail, signal: AbortSignal): Promise<PullFile[]> {
    const request = {
      owner: review.owner,
      repo: review.repo,
      installationId: review.installationId,
    };
    const before = await this.#pullRevision(request, review.number, signal);
    if (reviewedRevision(before, review)) {
      const files = await this.github.listPullFiles({ ...request, number: review.number }, signal);
      const after = await this.#pullRevision(request, review.number, signal);
      if (reviewedRevision(after, review)) return files;
    }
    return this.github.compareFiles(request, review.baseSha, review.sha, signal);
  }

  async #pullRevision(
    request: { owner: string; repo: string; installationId: number | null },
    number: number,
    signal: AbortSignal,
  ): Promise<{ sha: string; baseSha: string }> {
    try {
      const pull = await this.github.getPull(request, number, signal);
      return { sha: pull.sha, baseSha: pull.baseSha };
    } catch (error) {
      if (signal.aborted) throw error;
      return { sha: "", baseSha: "" };
    }
  }

  async #storePullSnapshot(review: ReviewDetail, files: PullFile[]): Promise<void> {
    try {
      await this.archive.writePullSnapshot(review.taskId, review.sha, files);
    } catch (error) {
      log("error", "could not store pull snapshot", {
        repo: `${review.owner}/${review.repo}`,
        pr: review.number,
        taskId: review.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async wait(taskId: TaskId<ReviewResult>) {
    return this.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  }

  /** Secret configured for `X-Hub-Signature-256`. The HTTP layer verifies with this before enqueueing. */
  configuredWebhookSecret(): string | undefined {
    return this.config.webhookSecret;
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
   * An omitted `trigger` uses `DUREVIEW_DEFAULT_TRIGGER` (`manual` unless the server sets it).
   * The review task reads that same ref again for thresholds and prompt rules.
   */
  async #pullRequest(request: ReviewRequest, action: PullReviewAction): Promise<WebhookResponse> {
    const signal = AbortSignal.timeout(20_000);
    let policy;
    try {
      policy = (
        await readBaseDureview(this.github, request, signal, { trigger: this.settings.effective().defaultTrigger })
      ).policy;
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
      forceSkipDrafts: this.settings.effective().skipDrafts,
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
    try {
      await this.harness.close(BACKGROUND_CONTEXT);
    } finally {
      this.settings.close();
      this.archive.close();
    }
  }
}

function reviewedRevision(
  pull: { sha: string; baseSha: string },
  review: { sha: string; baseSha: string },
): boolean {
  return pull.sha === review.sha && pull.baseSha === review.baseSha;
}

function isDeadline(signal: AbortSignal, error: unknown): boolean {
  return namedTimeout(signal.reason) || namedTimeout(error);
}

function namedTimeout(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("name" in value)) return false;
  if (value.name === "TimeoutError") return true;
  return "cause" in value && namedTimeout(value.cause);
}
