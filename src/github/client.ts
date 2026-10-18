import { createSign } from "node:crypto";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { activeGitHub } from "./access.js";
import type { StoredGitHubApp } from "./app-file.js";
import { isBranchRef } from "../review/trigger.js";
import type { GitHubRepo, ReviewRequest } from "../types.js";

export type IssueComment = { id: number; body: string };
export type PullReview = { id: number; body: string };
export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";

/** Conclusions the Checks API accepts when a check run completes. */
export type CheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "success"
  | "skipped"
  | "stale"
  | "timed_out";

export type CheckRun = {
  id: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: CheckConclusion | null;
  externalId: string | null;
};

export type ReviewCommentDraft = { path: string; line: number; startLine?: number; body: string };

/** Pull request fields needed to review the current head after a `/dureview` comment. */
export type RemotePull = {
  number: number;
  title: string;
  draft: boolean;
  sha: string;
  baseSha: string;
  baseRef: string;
};

/** A pull request review comment, joined with its GraphQL review thread when that lookup succeeds. */
export type PullReviewComment = {
  id: number;
  body: string;
  path: string;
  line: number | null;
  threadId: string | null;
  inReplyToId: number | null;
  reviewId: number | null;
  resolved: boolean;
};

/**
 * GitHub rejects REQUEST_CHANGES when the authenticated user opened the pull request.
 * Callers retry the same review as COMMENT.
 */
export class RequestChangesRejectedError extends Error {
  constructor(detail = "Can not request changes on your own pull request") {
    super(detail);
    this.name = "RequestChangesRejectedError";
  }
}

export function isRequestChangesRejected(error: unknown): boolean {
  if (error instanceof RequestChangesRejectedError) return true;
  if (!(error instanceof Error)) return false;
  const text = error.message.toLowerCase();
  return text.includes("own pull request") && text.includes("request change");
}

/** GitHub pull-request review comment body. Multi-line comments set start_line when the span is more than one line. */
export function reviewCommentPayload(comment: ReviewCommentDraft): {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT";
} {
  return {
    path: comment.path,
    line: comment.line,
    side: "RIGHT",
    body: comment.body,
    ...(comment.startLine !== undefined && comment.startLine < comment.line
      ? { start_line: comment.startLine, start_side: "RIGHT" as const }
      : {}),
  };
}

export interface GitHub {
  getPullDiff(request: ReviewRequest, signal: AbortSignal): Promise<string>;
  listIssueComments(request: ReviewRequest, signal: AbortSignal): Promise<IssueComment[]>;
  createIssueComment(request: ReviewRequest, body: string, signal: AbortSignal): Promise<IssueComment>;
  updateIssueComment(request: ReviewRequest, commentId: number, body: string, signal: AbortSignal): Promise<IssueComment>;
  listReviews(request: ReviewRequest, signal: AbortSignal): Promise<PullReview[]>;
  createReview(
    request: ReviewRequest,
    review: { sha: string; body: string; event?: ReviewEvent; comments: ReviewCommentDraft[] },
    signal: AbortSignal,
  ): Promise<PullReview>;
  /**
   * Inline review comments, including dureview markers and thread ids.
   * `threads: "required"` throws when the GraphQL thread lookup fails or the REST list is truncated.
   * A truncated list must not be classified: a missing comment would look unresolved.
   * The default keeps the comments and treats threads as unresolved, so a publish can reply instead of resolving.
   */
  listReviewComments(
    request: ReviewRequest,
    signal: AbortSignal,
    options?: { threads: "required" },
  ): Promise<PullReviewComment[]>;
  resolveReviewThread(request: ReviewRequest, threadId: string, signal: AbortSignal): Promise<void>;
  replyToReviewComment(
    request: ReviewRequest,
    commentId: number,
    body: string,
    signal: AbortSignal,
  ): Promise<PullReviewComment>;
  /** File contents at `ref`, or null when GitHub returns 404. `.dureview.md` is read from the base branch. */
  getRepoFile(request: GitHubRepo, path: string, ref: string, signal: AbortSignal): Promise<string | null>;
  /** Login that authored this installation's comments, or the PAT user. */
  viewerLogin(signal: AbortSignal): Promise<string>;
  /** Effective permission: `admin`, `maintain`, `write`, `triage`, `read`, or `none`. */
  collaboratorPermission(request: GitHubRepo, username: string, signal: AbortSignal): Promise<string>;
  getPull(request: GitHubRepo, number: number, signal: AbortSignal): Promise<RemotePull>;
  /** 👀 on an accepted `/dureview` comment. GitHub treats a repeat as the same reaction. */
  reactToComment(request: GitHubRepo, commentId: number, signal: AbortSignal): Promise<void>;
  /**
   * Changed files for a pull request's current head, including each file's patch when GitHub sends one.
   * This is not the file list at an older SHA.
   */
  listPullFiles(request: GitHubRepo & { number: number }, signal: AbortSignal): Promise<PullFile[]>;
  /**
   * Files in `base...head`. GitHub's compare route only accepts that three-dot form; `base..head` is a 404.
   * GitHub returns at most 300 files from this endpoint.
   */
  compareFiles(request: GitHubRepo, base: string, head: string, signal: AbortSignal): Promise<PullFile[]>;
  /**
   * File diff of commits after `reviewSha`, with patch line numbers on that commit.
   * Uses `reviewSha...head`. The patch is review-head-relative only when `reviewSha` is the merge base.
   * Returns null when the histories diverged, so callers leave those findings unclassified.
   */
  compareSinceReview(request: GitHubRepo, reviewSha: string, head: string, signal: AbortSignal): Promise<SinceReviewDiff | null>;
  /**
   * Check runs named `name` on `sha`, including in-progress runs (`filter=all`).
   * Used to reuse the run this task already opened after a crash between the create
   * call and the next checkpoint, and to close another in-progress run on the same SHA.
   */
  listCheckRuns(request: GitHubRepo, sha: string, name: string, signal: AbortSignal): Promise<CheckRun[]>;
  /** Opens an in-progress check run on `sha`. `externalId` is the review task id. */
  createCheckRun(
    request: GitHubRepo,
    input: { name: string; sha: string; externalId: string },
    signal: AbortSignal,
  ): Promise<CheckRun>;
  /** Completes a check run. `output` is the title and summary shown on the pull request. */
  updateCheckRun(
    request: GitHubRepo,
    checkRunId: number,
    input: { conclusion: CheckConclusion; title: string; summary: string; detailsUrl?: string },
    signal: AbortSignal,
  ): Promise<CheckRun>;
}

/** One file from `GET /repos/{owner}/{repo}/pulls/{number}/files`. */
export type PullFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  previousFilename: string | null;
};

/** GitHub's compare payload lists at most this many files. */
export const COMPARE_FILE_CAP = 300;

export type SinceReviewDiff = {
  files: PullFile[];
  /** True when the file list hit the compare cap, so some paths may be missing. */
  capped: boolean;
};

type CachedToken = { token: string; expiresAt: number };

export class GithubRest implements GitHub {
  #tokens = new Map<number, CachedToken>();
  #viewer: string | undefined;

  constructor(
    private readonly config: Config,
    private readonly storedApp: () => StoredGitHubApp | undefined = () => undefined,
  ) {}

  getPullDiff(request: ReviewRequest, signal: AbortSignal): Promise<string> {
    return this.#text(
      request,
      `/repos/${request.owner}/${request.repo}/pulls/${request.number}`,
      signal,
      "application/vnd.github.diff",
    );
  }

  async listIssueComments(request: ReviewRequest, signal: AbortSignal): Promise<IssueComment[]> {
    const page = await this.#pages<IssueComment>(
      request,
      `/repos/${request.owner}/${request.repo}/issues/${request.number}/comments`,
      signal,
    );
    return page.rows;
  }

  createIssueComment(request: ReviewRequest, body: string, signal: AbortSignal): Promise<IssueComment> {
    return this.#json(request, "POST", `/repos/${request.owner}/${request.repo}/issues/${request.number}/comments`, signal, {
      body,
    });
  }

  updateIssueComment(request: ReviewRequest, commentId: number, body: string, signal: AbortSignal): Promise<IssueComment> {
    return this.#json(request, "PATCH", `/repos/${request.owner}/${request.repo}/issues/comments/${commentId}`, signal, {
      body,
    });
  }

  async listReviews(request: ReviewRequest, signal: AbortSignal): Promise<PullReview[]> {
    const page = await this.#pages<PullReview>(
      request,
      `/repos/${request.owner}/${request.repo}/pulls/${request.number}/reviews`,
      signal,
    );
    return page.rows;
  }

  async createReview(
    request: ReviewRequest,
    review: { sha: string; body: string; event?: ReviewEvent; comments: ReviewCommentDraft[] },
    signal: AbortSignal,
  ): Promise<PullReview> {
    const event = review.event ?? "COMMENT";
    try {
      return await this.#json(request, "POST", `/repos/${request.owner}/${request.repo}/pulls/${request.number}/reviews`, signal, {
        commit_id: review.sha,
        body: review.body,
        event,
        comments: review.comments.map((comment) => reviewCommentPayload(comment)),
      });
    } catch (error) {
      if (event === "REQUEST_CHANGES" && isRequestChangesRejected(error)) {
        throw new RequestChangesRejectedError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async listReviewComments(
    request: ReviewRequest,
    signal: AbortSignal,
    options?: { threads: "required" },
  ): Promise<PullReviewComment[]> {
    const page = await this.#pages<RestReviewComment>(
      request,
      `/repos/${request.owner}/${request.repo}/pulls/${request.number}/comments`,
      signal,
    );
    if (page.truncated && options?.threads === "required") {
      throw new Error("GitHub review comment list was truncated.");
    }
    const rows = page.rows;
    let threads = new Map<number, { threadId: string; resolved: boolean }>();
    try {
      threads = await this.#threadIndex(request, signal);
    } catch (error) {
      if (options?.threads === "required") throw error;
      log("warn", "Could not load review threads; fixed findings will be replied to instead of resolved", {
        repo: `${request.owner}/${request.repo}`,
        pr: request.number,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return rows.map((row) => {
      const thread = threads.get(row.id);
      return {
        id: row.id,
        body: row.body,
        path: typeof row.path === "string" ? row.path : "",
        line: typeof row.line === "number" ? row.line : null,
        inReplyToId: typeof row.in_reply_to_id === "number" ? row.in_reply_to_id : null,
        reviewId: typeof row.pull_request_review_id === "number" ? row.pull_request_review_id : null,
        threadId: thread?.threadId ?? null,
        resolved: thread?.resolved ?? false,
      };
    });
  }

  async resolveReviewThread(request: ReviewRequest, threadId: string, signal: AbortSignal): Promise<void> {
    const data = await this.#graphql<{
      resolveReviewThread: { thread: { isResolved: boolean } | null } | null;
    }>(request, RESOLVE_REVIEW_THREAD, { id: threadId }, signal);
    if (!data.resolveReviewThread?.thread?.isResolved) {
      throw new Error(`GitHub did not resolve review thread ${threadId}.`);
    }
  }

  async replyToReviewComment(
    request: ReviewRequest,
    commentId: number,
    body: string,
    signal: AbortSignal,
  ): Promise<PullReviewComment> {
    const created = await this.#json<RestReviewComment>(
      request,
      "POST",
      `/repos/${request.owner}/${request.repo}/pulls/${request.number}/comments/${commentId}/replies`,
      signal,
      { body },
    );
    return {
      id: created.id,
      body: typeof created.body === "string" ? created.body : body,
      path: typeof created.path === "string" ? created.path : "",
      line: typeof created.line === "number" ? created.line : null,
      inReplyToId: commentId,
      reviewId: typeof created.pull_request_review_id === "number" ? created.pull_request_review_id : null,
      threadId: null,
      resolved: false,
    };
  }

  async #threadIndex(
    request: ReviewRequest,
    signal: AbortSignal,
  ): Promise<Map<number, { threadId: string; resolved: boolean }>> {
    const map = new Map<number, { threadId: string; resolved: boolean }>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const after = cursor;
      const data: ReviewThreadsData = await this.#graphql<ReviewThreadsData>(request, REVIEW_THREADS_QUERY, {
        owner: request.owner,
        name: request.repo,
        number: request.number,
        cursor: after,
      }, signal);
      const connection = data.repository?.pullRequest?.reviewThreads;
      if (!connection) break;
      for (const node of connection.nodes ?? []) {
        if (!node?.id) continue;
        for (const comment of node.comments?.nodes ?? []) {
          if (typeof comment?.databaseId !== "number") continue;
          map.set(comment.databaseId, { threadId: node.id, resolved: node.isResolved === true });
        }
      }
      if (!connection.pageInfo?.hasNextPage) break;
      cursor = connection.pageInfo.endCursor ?? null;
      if (!cursor) break;
    }
    return map;
  }

  async #graphql<T>(
    request: ReviewRequest,
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    const payload = await this.#json<{ data?: T; errors?: Array<{ message?: string }> }>(
      request,
      "POST",
      "/graphql",
      signal,
      { query, variables },
    );
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((error) => error.message ?? "GraphQL error").join("; "));
    }
    if (payload.data === undefined) throw new Error("GitHub GraphQL response had no data.");
    return payload.data;
  }

  async #pages<T extends { id: number; body?: string | null }>(
    request: ReviewRequest,
    path: string,
    signal: AbortSignal,
  ): Promise<{ rows: Array<T & { body: string }>; truncated: boolean }> {
    const collected: Array<T & { body: string }> = [];
    let next: string | undefined = withPerPage(path, COMMENT_PAGE_SIZE);
    for (let page = 0; page < COMMENT_PAGE_CAP && next; page++) {
      const response = await this.#send(request, "GET", next, signal);
      const rows = (await response.json()) as T[];
      if (!Array.isArray(rows)) throw new Error(`GitHub ${path} did not return a list`);
      for (const row of rows) {
        if (!row || typeof row.id !== "number") continue;
        collected.push({ ...row, body: typeof row.body === "string" ? row.body : "" });
      }
      next = linkNext(response.headers.get("link"));
    }
    return { rows: collected, truncated: next !== undefined };
  }

  async #text(request: { installationId: number | null }, path: string, signal: AbortSignal, accept: string): Promise<string> {
    const response = await this.#send(request, "GET", path, signal, undefined, accept);
    return response.text();
  }

  async #json<T>(
    request: { installationId: number | null },
    method: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const response = await this.#send(request, method, path, signal, body);
    return (await response.json()) as T;
  }

  async #send(
    request: { installationId: number | null },
    method: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<Response> {
    const token = await this.#token(request, signal);
    const url = path.startsWith("https://") ? path : `${this.config.githubApiUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await fetch(url, {
        method,
        signal,
        headers: {
          accept,
          authorization: `Bearer ${token}`,
          "user-agent": "dureview",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.ok) return response;
      const detail = (await response.text()).slice(0, 500);
      lastError = new Error(`GitHub ${method} ${path} failed (${response.status}): ${detail}`);
      if (response.status !== 429 && response.status < 500) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      await delay(signal, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * attempt);
    }
    throw lastError;
  }

  async getRepoFile(request: GitHubRepo, filePath: string, ref: string, signal: AbortSignal): Promise<string | null> {
    const encoded = filePath
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const path = `/repos/${request.owner}/${request.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
    try {
      return await this.#text(request, path, signal, "application/vnd.github.raw");
    } catch (error) {
      if (githubStatus(error) === 404) return null;
      throw error;
    }
  }

  async viewerLogin(signal: AbortSignal): Promise<string> {
    if (this.#viewer) return this.#viewer;
    const app = this.#appCredentials();
    if (app) {
      const slug = await this.#appSlug(app, signal);
      this.#viewer = `${slug}[bot]`;
      return this.#viewer;
    }
    const payload = await this.#json<{ login?: unknown }>({ installationId: null }, "GET", "/user", signal);
    if (typeof payload.login !== "string" || payload.login.length === 0) {
      throw new Error("GitHub user response had no login.");
    }
    this.#viewer = payload.login;
    return this.#viewer;
  }

  async collaboratorPermission(request: GitHubRepo, username: string, signal: AbortSignal): Promise<string> {
    const path = `/repos/${request.owner}/${request.repo}/collaborators/${encodeURIComponent(username)}/permission`;
    try {
      const payload = await this.#json<{ permission?: unknown }>(request, "GET", path, signal);
      if (typeof payload.permission !== "string" || payload.permission.length === 0) {
        throw new Error("GitHub permission response had no permission.");
      }
      return payload.permission;
    } catch (error) {
      if (githubStatus(error) === 404) return "none";
      throw error;
    }
  }

  async getPull(request: GitHubRepo, number: number, signal: AbortSignal): Promise<RemotePull> {
    const payload = await this.#json<unknown>(request, "GET", `/repos/${request.owner}/${request.repo}/pulls/${number}`, signal);
    return parseRemotePull(payload, number);
  }

  async reactToComment(request: GitHubRepo, commentId: number, signal: AbortSignal): Promise<void> {
    await this.#json(request, "POST", `/repos/${request.owner}/${request.repo}/issues/comments/${commentId}/reactions`, signal, {
      content: "eyes",
    });
  }

  async listPullFiles(request: GitHubRepo & { number: number }, signal: AbortSignal): Promise<PullFile[]> {
    const collected: PullFile[] = [];
    let next: string | undefined =
      `/repos/${request.owner}/${request.repo}/pulls/${request.number}/files?per_page=100`;
    for (let page = 0; page < 30 && next; page += 1) {
      const response = await this.#send(request, "GET", next, signal);
      collected.push(...parsePullFiles(await response.json()));
      next = linkNext(response.headers.get("link"));
    }
    return collected;
  }

  async compareFiles(request: GitHubRepo, base: string, head: string, signal: AbortSignal): Promise<PullFile[]> {
    const payload = await this.#comparePayload(request, base, head, signal);
    return parsePullFiles(payload.files);
  }

  async compareSinceReview(
    request: GitHubRepo,
    reviewSha: string,
    head: string,
    signal: AbortSignal,
  ): Promise<SinceReviewDiff | null> {
    const payload = await this.#comparePayload(request, reviewSha, head, signal);
    const mergeBase = isRecord(payload.merge_base_commit) ? payload.merge_base_commit.sha : undefined;
    if (typeof mergeBase !== "string" || !COMMIT_SHA.test(mergeBase)) {
      throw new Error("GitHub compare did not return a merge base.");
    }
    if (mergeBase.toLowerCase() !== reviewSha.toLowerCase()) return null;
    return { files: parsePullFiles(payload.files), capped: payload.files.length >= COMPARE_FILE_CAP };
  }

  async #comparePayload(
    request: GitHubRepo,
    base: string,
    head: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> & { files: unknown[] }> {
    if (!COMMIT_SHA.test(base) || !COMMIT_SHA.test(head)) {
      throw new Error("GitHub compare requires a base SHA and a head SHA.");
    }
    const basehead = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const payload = await this.#json<unknown>(
      request,
      "GET",
      `/repos/${request.owner}/${request.repo}/compare/${basehead}`,
      signal,
    );
    if (!isRecord(payload) || !Array.isArray(payload.files)) {
      throw new Error("GitHub compare did not return a file list.");
    }
    return { ...payload, files: payload.files };
  }

  async listCheckRuns(request: GitHubRepo, sha: string, name: string, signal: AbortSignal): Promise<CheckRun[]> {
    const collected: CheckRun[] = [];
    const checkName = encodeURIComponent(name);
    const ref = encodeURIComponent(sha);
    for (let page = 1; page <= 5; page++) {
      const path = `/repos/${request.owner}/${request.repo}/commits/${ref}/check-runs?check_name=${checkName}&filter=all&per_page=100&page=${page}`;
      const payload = await this.#json<{ check_runs?: unknown }>(request, "GET", path, signal);
      const runs = Array.isArray(payload.check_runs) ? payload.check_runs : [];
      for (const run of runs) {
        const parsed = parseCheckRun(run);
        if (parsed) collected.push(parsed);
      }
      if (runs.length < 100) break;
    }
    return collected;
  }

  async createCheckRun(
    request: GitHubRepo,
    input: { name: string; sha: string; externalId: string },
    signal: AbortSignal,
  ): Promise<CheckRun> {
    const payload = await this.#json(
      request,
      "POST",
      `/repos/${request.owner}/${request.repo}/check-runs`,
      signal,
      {
        name: input.name,
        head_sha: input.sha,
        status: "in_progress",
        external_id: input.externalId,
        started_at: new Date().toISOString(),
      },
    );
    const parsed = parseCheckRun(payload);
    if (!parsed) throw new Error("GitHub check run response had no id.");
    return parsed;
  }

  async updateCheckRun(
    request: GitHubRepo,
    checkRunId: number,
    input: { conclusion: CheckConclusion; title: string; summary: string; detailsUrl?: string },
    signal: AbortSignal,
  ): Promise<CheckRun> {
    const payload = await this.#json(
      request,
      "PATCH",
      `/repos/${request.owner}/${request.repo}/check-runs/${checkRunId}`,
      signal,
      {
        status: "completed",
        conclusion: input.conclusion,
        completed_at: new Date().toISOString(),
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
        output: { title: input.title, summary: input.summary },
      },
    );
    const parsed = parseCheckRun(payload);
    if (!parsed) throw new Error("GitHub check run response had no id.");
    return parsed;
  }

  accessToken(request: ReviewRequest, signal: AbortSignal): Promise<string> {
    return this.#token(request, signal);
  }

  async #appSlug(app: { appId: string; privateKey: string }, signal: AbortSignal): Promise<string> {
    const jwt = appJwt(app.appId, app.privateKey);
    const response = await fetch(`${this.config.githubApiUrl}/app`, {
      signal,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "user-agent": "dureview",
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitHub App lookup failed (${response.status}): ${detail}`);
    }
    const payload = (await response.json()) as { slug?: unknown };
    if (typeof payload.slug !== "string" || !/^[A-Za-z0-9-]+$/.test(payload.slug)) {
      throw new Error("GitHub App response had no slug.");
    }
    return payload.slug;
  }

  #appCredentials(): { appId: string; privateKey: string } | undefined {
    const active = activeGitHub(this.config, this.storedApp());
    if (active.kind !== "app") return undefined;
    return { appId: active.appId, privateKey: active.privateKey };
  }

  async #token(request: { installationId: number | null }, signal: AbortSignal): Promise<string> {
    const active = activeGitHub(this.config, this.storedApp());
    if (active.kind === "token") return active.token;
    if (active.kind === "none") throw new Error("GitHub authentication is not configured.");
    if (request.installationId === null) {
      throw new Error("GitHub App webhook payload did not include installation.id.");
    }
    const cached = this.#tokens.get(request.installationId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const jwt = appJwt(active.appId, active.privateKey);
    const response = await fetch(
      `${this.config.githubApiUrl}/app/installations/${request.installationId}/access_tokens`,
      {
        method: "POST",
        signal,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "user-agent": "dureview",
        },
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitHub App installation token failed (${response.status}): ${detail}`);
    }
    const payload = (await response.json()) as { token?: string; expires_at?: string };
    if (!payload.token) throw new Error("GitHub App installation token response had no token.");
    const expiresAt = payload.expires_at ? Date.parse(payload.expires_at) : Date.now() + 50 * 60 * 1000;
    this.#tokens.set(request.installationId, { token: payload.token, expiresAt });
    log("info", "Minted GitHub App installation token", { installationId: request.installationId });
    return payload.token;
  }
}

export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const issued = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issued, exp: issued + 9 * 60, iss: appId }));
  const data = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return `${data}.${signer.sign(privateKey).toString("base64url")}`;
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

/** Keep files whose names stay inside the repository. A missing patch stays null. */
export function parsePullFiles(payload: unknown): PullFile[] {
  if (!Array.isArray(payload)) throw new Error("GitHub pull files did not return a list");
  const files: PullFile[] = [];
  for (const row of payload) {
    if (!isRecord(row) || typeof row.filename !== "string") continue;
    const filename = row.filename.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!filename || filename.startsWith("/") || filename.split("/").includes("..")) continue;
    files.push({
      filename,
      status: typeof row.status === "string" ? row.status : "modified",
      additions: nonNegative(row.additions),
      deletions: nonNegative(row.deletions),
      patch: typeof row.patch === "string" ? row.patch : null,
      previousFilename: typeof row.previous_filename === "string" ? row.previous_filename : null,
    });
  }
  return files;
}

function nonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

/** GitHub defaults to 30. Ten pages of that hide every comment after the first 300. */
const COMMENT_PAGE_SIZE = 100;
const COMMENT_PAGE_CAP = 10;

function withPerPage(path: string, perPage: number): string {
  if (/[?&]per_page=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}per_page=${perPage}`;
}

function linkNext(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

type RestReviewComment = {
  id: number;
  body?: string | null;
  path?: string | null;
  line?: number | null;
  in_reply_to_id?: number | null;
  pull_request_review_id?: number | null;
};

type ReviewThreadsData = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: { nodes: Array<{ databaseId: number | null } | null> | null } | null;
        } | null> | null;
      } | null;
    } | null;
  } | null;
};

const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first:100) { nodes { databaseId } }
        }
      }
    }
  }
}`;

const RESOLVE_REVIEW_THREAD = `mutation($id:ID!) {
  resolveReviewThread(input:{threadId:$id}) { thread { isResolved } }
}`;

const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

function parseRemotePull(payload: unknown, number: number): RemotePull {
  if (!isRecord(payload)) throw new Error("GitHub pull request response was not an object.");
  const title = typeof payload.title === "string" ? payload.title : "";
  const draft = payload.draft === true;
  const head = isRecord(payload.head) ? payload.head : undefined;
  const base = isRecord(payload.base) ? payload.base : undefined;
  const sha = head && typeof head.sha === "string" ? head.sha : "";
  const baseSha = base && typeof base.sha === "string" ? base.sha : "";
  const baseRef = base && typeof base.ref === "string" ? base.ref : "";
  if (payload.number !== number || !COMMIT_SHA.test(sha) || !COMMIT_SHA.test(baseSha) || !isBranchRef(baseRef)) {
    throw new Error(`GitHub pull request ${number} was missing a head SHA or base branch.`);
  }
  return { number, title, draft, sha, baseSha, baseRef };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CHECK_CONCLUSIONS = new Set<CheckConclusion>([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "success",
  "skipped",
  "stale",
  "timed_out",
]);

function parseCheckRun(value: unknown): CheckRun | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  const status = value.status === "queued" || value.status === "in_progress" || value.status === "completed"
    ? value.status
    : "queued";
  const conclusion = typeof value.conclusion === "string" && CHECK_CONCLUSIONS.has(value.conclusion as CheckConclusion)
    ? (value.conclusion as CheckConclusion)
    : null;
  return {
    id: value.id,
    status,
    conclusion,
    externalId: typeof value.external_id === "string" ? value.external_id : null,
  };
}

export function githubStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /failed \((\d+)\)/.exec(error.message);
  return match?.[1] ? Number(match[1]) : undefined;
}

function delay(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}
