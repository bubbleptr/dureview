import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Credential, Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { LoginSessions } from "./auth/device-login.js";
import { authFile, resolveProvider, storageFile } from "./auth/session.js";
import { FileCredentialStore } from "./auth/store.js";
import { isSubscriptionProvider } from "./auth/providers.js";
import { apiKeyView, assertApiKeyProvider, parseApiKey, publicAuthError, subscriptionView } from "./auth/reveal.js";
import { baselineFromConfig, type Config, type EditableBaseline } from "./config.js";
import { GitHubAppFile } from "./github/app-file.js";
import { activeGitHub, activeWebhookSecret, githubSetupView } from "./github/access.js";
import { probeInstallations } from "./github/probe.js";
import {
  buildManifest,
  exchangeAppManifest,
  githubSetupCookie,
  handoffResponse,
  manifestCreateUrl,
  manifestHandoffPage,
  newSetupState,
  statesMatch,
} from "./github/manifest.js";
import { githubWebOrigin } from "./github/web.js";
import { redirectResponse } from "./http/headers.js";
import { ServerSettings, type EffectiveConfig, type SettingsWriteResult } from "./settings/effective.js";
import type { ConsoleView, SettingsFormValues, SettingsPageModel } from "./settings/page.js";
import type { GitHub } from "./github/client.js";
import { verifyGithubSignature } from "./github/signature.js";
import { parseWebhook, type ReviewCommand } from "./github/webhook.js";
import { classifyFindingAdoption, findingThreadResolved } from "./review/adoption.js";
import { log } from "./log.js";
import { readBaseDureview, safeRepoPath, type RepoCheckout } from "./review/checkout.js";
import { loadReviewFilePair, matchReviewedFile, type ReviewFileContents } from "./ui/file-contents.js";
import { ReviewArchive, REVIEWS_DB_FILE, type ReviewDetail, type ReviewFilter, type ReviewList } from "./review/archive.js";
import type { StatsQuery, StatsSnapshot } from "./review/stats.js";
import type { PullFile } from "./github/client.js";
import { ReviewLog, type ReviewFinished, type ReviewLogEntry } from "./review/history.js";
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
  credentials?: FileCredentialStore;
  logins?: LoginSessions;
  githubApps?: GitHubAppFile;
};

export type WebhookResponse = { status: number; body: Record<string, unknown> };

/** GitHub does not redeliver a 500. The checkout sweep retries a stored close this many times. */
export const ADOPTION_RETRY_CAP = 5;

const GITHUB_SETUP_BUSY = "GitHub setup is already finishing. Start it again from settings.";

export class DureviewService {
  #githubState: { state: string; expires: number } | null = null;
  #githubExchange = false;
  #githubNotice: string | null = null;

  private constructor(
    readonly harness: Harness,
    private readonly rootId: ConversationId,
    private readonly task: ReturnType<typeof createReviewRuntime>["task"],
    private readonly config: Config,
    private readonly github: GitHub,
    private readonly reviews: ReviewLog,
    private readonly archive: ReviewArchive,
    private readonly settings: ServerSettings,
    private readonly credentials: FileCredentialStore,
    private readonly logins: LoginSessions,
    private readonly githubApps: GitHubAppFile,
    private readonly models: Models,
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
    const adoption = {
      afterArchive: (_event: ReviewFinished): Promise<void> => Promise.resolve(),
    };
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
        try {
          await adoption.afterArchive(event);
        } catch (error) {
          log("error", "could not classify adoption after archive", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
    const registry = createRegistry();
    registry.install(extension);
    let harness: Harness;
    try {
      harness = await Harness.open(
      await openNodeSqliteStorage(storageFile(options.config)),
      {
        models: withMaxOutputTokens(options.models, () => settings.effective().maxOutputTokens),
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
    const credentials = options.credentials ?? new FileCredentialStore(authFile(options.config));
    const logins =
      options.logins ??
      new LoginSessions((provider, interaction) => options.models.login(provider, "oauth", interaction, { agentName: "dureview" }));
    const githubApps = options.githubApps ?? (await GitHubAppFile.open(join(options.config.dataDir, "github-app.json")));
    const service = new DureviewService(
      harness,
      root.id,
      task,
      options.config,
      options.github,
      reviews,
      archive,
      settings,
      credentials,
      logins,
      githubApps,
      options.models,
    );
    adoption.afterArchive = (event) => service.#classifyClosedPull(event);
    return service;
  }

  /** Model, thinking, trigger, draft skip, checkout TTL, and output token cap after overrides. */
  effectiveConfig(): EffectiveConfig {
    return this.settings.effective();
  }

  checkoutTtlMs(): number {
    return this.settings.effective().checkoutTtlDays * 24 * 60 * 60 * 1000;
  }

  async settingsPage(extra?: { error?: string | null; saved?: boolean; notice?: string | null }): Promise<SettingsPageModel> {
    await this.#refreshProviderFallback();
    this.logins.acknowledgeDone();
    const storedNotice = this.#takeGitHubNotice();
    const notice = extra?.notice ?? storedNotice;
    return this.settings.page({ ...extra, notice, console: await this.consoleView() });
  }

  async consoleView(): Promise<ConsoleView> {
    const subscriptions = [];
    for (const provider of ["openai-codex", "github-copilot", "xai"] as const) {
      try {
        subscriptions.push(subscriptionView(provider, await this.credentials.read(provider), false));
      } catch {
        subscriptions.push(subscriptionView(provider, undefined, true));
      }
    }
    const apiKeys = [];
    for (const provider of ["openai", "openrouter", "deepseek"] as const) {
      let credential: Credential | undefined;
      try {
        credential = await this.credentials.read(provider);
      } catch {
        credential = undefined;
      }
      apiKeys.push(apiKeyView(provider, credential, process.env));
    }
    return { subscriptions, apiKeys, logins: this.logins.snapshot(), github: await this.#githubView() };
  }

  loginSnapshot(): ConsoleView["logins"] {
    return this.logins.snapshot();
  }

  startSubscriptionLogin(provider: string, enterprise: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const started = this.logins.start(provider, enterprise);
    if (!started.ok) return Promise.resolve(started);
    return this.logins.waitForCode(provider, 3000).then(() => ({ ok: true as const }));
  }

  async logoutSubscription(provider: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isSubscriptionProvider(provider)) return { ok: false, error: "Unknown provider." };
    this.logins.abort(provider);
    await this.models.logout(provider);
    await this.#refreshProviderFallback();
    return { ok: true };
  }

  async saveApiKey(provider: string, key: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = assertApiKeyProvider(provider);
    const parsed = parseApiKey(key);
    if (!id || !parsed) return { ok: false, error: "Enter an API key at least 8 characters long, with no spaces." };
    const current = await this.credentials.read(id);
    if (current?.type === "oauth") return { ok: false, error: "Log out of the subscription before saving an API key." };
    await this.credentials.modify(id, async () => ({ type: "api_key", key: parsed }));
    return { ok: true };
  }

  async clearApiKey(provider: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const id = assertApiKeyProvider(provider);
    if (!id) return { ok: false, error: "Unknown provider." };
    const current = await this.credentials.read(id);
    if (current?.type === "api_key") await this.credentials.delete(id);
    return { ok: true };
  }

  beginGitHubSetup(origin: string, org: string): Response | null {
    if (this.#githubExchange) {
      return redirectResponse(`/ui/settings?problem=${encodeURIComponent(GITHUB_SETUP_BUSY)}`);
    }
    const web = githubWebOrigin(this.config.githubApiUrl);
    const action = web ? manifestCreateUrl(this.config.githubApiUrl, org) : null;
    if (!web || !action) return null;
    const state = newSetupState();
    this.#githubState = { state, expires: Date.now() + 10 * 60 * 1000 };
    const manifest = buildManifest(origin, state);
    return handoffResponse(manifestHandoffPage(action, manifest), githubSetupCookie(state), web);
  }

  async finishGitHubSetup(state: string, code: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.#githubExchange) {
      return { ok: false, error: GITHUB_SETUP_BUSY };
    }
    const expected = this.#githubState;
    if (!expected || expected.expires < Date.now() || !statesMatch(expected.state, state)) {
      if (expected && expected.expires < Date.now()) this.#githubState = null;
      return { ok: false, error: "GitHub setup expired. Start it again from settings." };
    }
    this.#githubExchange = true;
    try {
      const app = await exchangeAppManifest({ code, apiUrl: this.config.githubApiUrl, signal });
      await this.githubApps.save(app);
      this.#githubNotice = "GitHub App saved.";
      this.#githubState = null;
      return { ok: true };
    } catch (error) {
      this.#githubState = null;
      return { ok: false, error: publicAuthError(error) };
    } finally {
      this.#githubExchange = false;
    }
  }

  async clearGitHubApp(): Promise<{ ok: true } | { ok: false; error: string }> {
    await this.githubApps.clear();
    return { ok: true };
  }

  githubAuthKind(): "app" | "token" | "none" {
    const active = activeGitHub(this.config, this.githubApps.current());
    return active.kind === "app" ? "app" : active.kind;
  }

  saveSettings(input: Partial<SettingsFormValues>, actor: string): Promise<SettingsWriteResult> {
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
    return activeWebhookSecret(this.config, this.githubApps.current()).secret;
  }

  async handleWebhook(raw: Buffer, signature: string | undefined, event: string | undefined): Promise<WebhookResponse> {
    await this.#refreshProviderFallback();
    const secret = this.configuredWebhookSecret();
    if (!secret) {
      return { status: 500, body: { error: "webhook secret is not configured" } };
    }
    if (!verifyGithubSignature(raw, signature, secret)) {
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
    if (parsed.kind === "closed") return this.#classifyAdoption(parsed.request, parsed.merged, "webhook");
    return this.#pullRequest(parsed.request, parsed.action);
  }

  /**
   * On pull_request closed, classify each posted inline comment once.
   * A delivery that cannot read GitHub leaves those rows unset.
   * GitHub does not redeliver that 500; the checkout sweep retries the stored close.
   * The close is stored first: a review that archives after this delivery classifies against it.
   */
  async #classifyAdoption(
    request: ReviewRequest,
    merged: boolean,
    source: "webhook" | "stored",
  ): Promise<WebhookResponse> {
    if (source === "webhook") {
      await this.archive.rememberClosedPull(request, merged);
    } else {
      // The in-memory close can outlive a reopen. Re-inserting it would classify later reviews against that head.
      const current = await this.archive.closedPull(request.owner, request.repo, request.number);
      if (!current) return { status: 200, body: { ok: true, classified: 0, merged } };
      request = current.request;
      merged = current.merged;
    }
    const findings = await this.archive.unclassifiedPosts(request.owner, request.repo, request.number);
    if (findings.length === 0) return { status: 200, body: { ok: true, classified: 0, merged } };
    const signal = AbortSignal.timeout(20_000);
    let comments;
    try {
      comments = await this.github.listReviewComments(request, signal, { threads: "required" });
    } catch (error) {
      log("error", "could not classify adoption", {
        repo: `${request.owner}/${request.repo}`,
        pr: request.number,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 500, body: { error: "could not classify adoption" } };
    }
    const bySha = new Map<string, typeof findings>();
    for (const finding of findings) {
      const group = bySha.get(finding.sha) ?? [];
      group.push(finding);
      bySha.set(finding.sha, group);
    }
    const repo = { owner: request.owner, repo: request.repo, installationId: request.installationId };
    const updates: Array<{ id: number; adoption: "adopted" | "ignored"; head: string }> = [];
    let incomplete = false;
    for (const [sha, group] of bySha) {
      let files: PullFile[] = [];
      let diffCapped = false;
      if (sha !== request.sha) {
        try {
          const compared = await this.github.compareSinceReview(repo, sha, request.sha, signal);
          if (compared === null) {
            log("warn", "adoption diff is not relative to the reviewed head", {
              repo: `${request.owner}/${request.repo}`,
              pr: request.number,
            });
            continue;
          }
          files = compared.files;
          diffCapped = compared.capped;
        } catch (error) {
          incomplete = true;
          log("error", "could not compare commits for adoption", {
            repo: `${request.owner}/${request.repo}`,
            pr: request.number,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
      }
      for (const finding of group) {
        const adoption = classifyFindingAdoption({
          pullOpen: false,
          reviewSha: sha,
          finalHeadSha: request.sha,
          threadResolved: findingThreadResolved(
            { fingerprint: finding.fingerprint, taskId: finding.taskId },
            comments,
          ),
          diffCapped,
          finding,
          files,
        });
        if (adoption !== "adopted" && adoption !== "ignored") continue;
        updates.push({ id: finding.id, adoption, head: request.sha });
      }
    }
    const classified = await this.archive.recordAdoption(updates);
    if (incomplete) return { status: 500, body: { error: "could not classify adoption" } };
    return { status: 200, body: { ok: true, classified, merged } };
  }

  /**
   * Classify stored closes that still have unset posted comments.
   * Startup and the checkout sweep call this. Each failure counts toward ADOPTION_RETRY_CAP.
   */
  async retryClosedAdoption(): Promise<void> {
    const pending = await this.archive.closesAwaitingAdoption(ADOPTION_RETRY_CAP);
    for (const closed of pending) {
      const { owner, repo, number } = closed.request;
      try {
        const result = await this.#classifyAdoption(closed.request, closed.merged, "stored");
        const left = await this.archive.unclassifiedPosts(owner, repo, number);
        if (result.status === 200 && left.length === 0) continue;
      } catch (error) {
        log("error", "could not retry adoption", {
          repo: `${owner}/${repo}`,
          pr: number,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await this.archive.noteCloseAttempt(owner, repo, number);
    }
  }

  /** A review that finishes after the pull request closed still gets an adoption outcome. */
  async #classifyClosedPull(event: ReviewFinished): Promise<void> {
    const closed = await this.archive.closedPull(event.owner, event.repo, event.number);
    if (!closed) return;
    const result = await this.#classifyAdoption(closed.request, closed.merged, "stored");
    if (result.status !== 200) {
      log("error", "could not classify adoption after archive", {
        repo: `${event.owner}/${event.repo}`,
        pr: event.number,
      });
    }
  }

  /**
   * `.dureview.md` comes from the base branch. A pull request cannot change `trigger` or `drafts`.
   * An omitted `trigger` uses `DUREVIEW_DEFAULT_TRIGGER` (`manual` unless the server sets it).
   * The review task reads that same ref again for thresholds and prompt rules.
   */
  async #pullRequest(request: ReviewRequest, action: PullReviewAction): Promise<WebhookResponse> {
    if (action === "reopened") await this.archive.forgetClosedPull(request.owner, request.repo, request.number);
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

  async #githubView(): Promise<ConsoleView["github"]> {
    const stored = this.githubApps.current();
    const active = activeGitHub(this.config, stored);
    const probe =
      active.kind === "app"
        ? await probeInstallations({
            apiUrl: this.config.githubApiUrl,
            appId: active.appId,
            privateKey: active.privateKey,
          })
        : null;
    return githubSetupView({
      config: this.config,
      stored,
      unreadable: this.githubApps.unreadable(),
      probe,
    });
  }

  async #refreshProviderFallback(): Promise<void> {
    if (this.config.provider) return;
    const detected = await resolveProvider({ ...this.config, provider: undefined }, this.models);
    this.settings.setFallbackProvider(detected);
  }

  #takeGitHubNotice(): string | null {
    const notice = this.#githubNotice;
    this.#githubNotice = null;
    return notice;
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

function cappedOutputTokens(model: { maxTokens?: number }, configured: number): number {
  const limit = model.maxTokens;
  return typeof limit === "number" && limit > 0 ? Math.min(configured, limit) : configured;
}

function withMaxOutputTokens(models: Models, maxOutputTokens: () => number): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) =>
    models.streamSimple(model, context, { ...options, maxTokens: cappedOutputTokens(model, maxOutputTokens()) });
  const completeSimple: Models["completeSimple"] = (model, context, options) =>
    models.completeSimple(model, context, { ...options, maxTokens: cappedOutputTokens(model, maxOutputTokens()) });
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "streamSimple") return streamSimple;
      if (property === "completeSimple") return completeSimple;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
