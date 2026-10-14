import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { Config } from "../src/config.js";
import {
  RequestChangesRejectedError,
  type CheckConclusion,
  type CheckRun,
  type GitHub,
  type IssueComment,
  type PullReview,
  type PullReviewComment,
  type RemotePull,
  type ReviewCommentDraft,
  type PullFile,
  type ReviewEvent,
} from "../src/github/client.js";
import { loadDureviewFile, type Checkout, type RepoCheckout } from "../src/review/checkout.js";
import { defaultPolicy, type ReviewPolicy } from "../src/review/policy.js";
import { findingFingerprint, type Finding, type ReviewSubmission, type Verdict } from "../src/review/schema.js";
import type { ReviewHooks } from "../src/review/task.js";
import { DureviewService } from "../src/service.js";
import type { GitHubRepo, ReviewRequest } from "../src/types.js";

export const SECRET = "test-webhook-secret";
export const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const BASE_SHA = "1111111111111111111111111111111111111111";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, "fixtures", "repo");

export const FIXTURE_DIFF = `diff --git a/src/pay.ts b/src/pay.ts
index 1111111..2222222 100644
--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,5 +1,6 @@
 export function charge(amount: number): { ok: boolean } {
-  return gateway.capture(amount);
+  if (amount > 0) return { ok: true };
+  return gateway.capture(amount);
 }
 
 const gateway = {
`;

export function sampleFinding(overrides: Partial<Omit<Finding, "fingerprint">> = {}): Finding {
  const finding = {
    title: "Return success without billing",
    priority: 1 as const,
    kind: "bug" as const,
    category: "correctness" as const,
    path: "src/pay.ts",
    startLine: 2,
    endLine: 2,
    body: "Positive amounts return success without capturing the charge, so the customer is never billed.",
    trigger: "charge() is called with a positive amount.",
    evidence: [] as string[],
    suggestion: null,
    cwe: null,
    ruleRef: null,
    confidence: 0.9,
    ...overrides,
  };
  return { ...finding, fingerprint: findingFingerprint(finding) };
}

export const FINDING: Finding = sampleFinding();

export function reviewSubmission(
  verdictReason: string,
  findings: Finding[] = [FINDING],
  verdict?: Verdict,
): ReviewSubmission {
  return {
    verdict: verdict ?? (findings.length === 0 ? "clean" : "fix_recommended"),
    verdictReason,
    overallConfidence: 0.8,
    checked: ["payment capture on the happy path"],
    findings,
  };
}

export function findingArgs(finding: Finding) {
  return {
    title: finding.title,
    priority: finding.priority,
    kind: finding.kind,
    category: finding.category,
    path: finding.path,
    start_line: finding.startLine,
    end_line: finding.endLine,
    body: finding.body,
    trigger: finding.trigger,
    evidence: finding.evidence,
    suggestion: finding.suggestion,
    cwe: finding.cwe,
    rule_ref: finding.ruleRef,
    confidence: finding.confidence,
  };
}

export const POLICY: ReviewPolicy = defaultPolicy();

export function reviewRequest(sha = SHA_A): ReviewRequest {
  return {
    owner: "acme",
    repo: "demo",
    number: 7,
    sha,
    baseSha: BASE_SHA,
    baseRef: "main",
    title: "Charge positive amounts",
    cloneUrl: "https://github.com/acme/demo.git",
    installationId: 99,
    draft: false,
  };
}

export function pullPayload(sha = SHA_A, action = "opened"): Record<string, unknown> {
  return {
    action,
    installation: { id: 99 },
    repository: {
      name: "demo",
      clone_url: "https://github.com/acme/demo.git",
      owner: { login: "acme" },
    },
    pull_request: {
      number: 7,
      title: "Charge positive amounts",
      draft: false,
      head: { sha },
      base: { sha: BASE_SHA, ref: "main" },
    },
  };
}

export function scriptedReview(summary: string, findings: Finding[] = [FINDING]): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall("read", { path: "src/pay.ts" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("grep", { pattern: "capture" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(
      fauxToolCall("submit_review", {
        verdict: findings.length === 0 ? "clean" : "fix_recommended",
        verdict_reason: summary,
        overall_confidence: 0.8,
        checked: ["payment capture on the happy path"],
        findings: findings.map((finding) => findingArgs(finding)),
      }),
      { stopReason: "toolUse" },
    ),
  ];
}

export class MemoryGitHub implements GitHub {
  comments: IssueComment[] = [];
  reviews: Array<PullReview & { comments: ReviewCommentDraft[]; event: ReviewEvent }> = [];
  reviewComments: PullReviewComment[] = [];
  /** Method names invoked, in order. */
  calls: string[] = [];
  /** `${ref}\\0${path}` → file text. Missing keys are 404. */
  files = new Map<string, string>();
  /** Refs passed to getRepoFile, in order. */
  fileRefs: string[] = [];
  viewer = "dureview[bot]";
  /** Username → permission. Missing users are `none`. */
  permissions = new Map<string, string>();
  reactions: Array<{ commentId: number; content: string }> = [];
  remotePull: RemotePull | null = null;
  /** Check runs opened for a review, newest write last in `checkLog`. */
  checkRuns: MemoryCheckRun[] = [];
  /** Every create and update, including the in-progress create. */
  checkLog: MemoryCheckRun[] = [];
  /** When set, check run calls throw `GitHub ... failed (status)`. */
  checkErrorStatus: number | null = null;
  /** Remaining `updateCheckRun` failures. Each call throws 500 and decrements. */
  checkUpdateFailures = 0;
  /** After a check run is stored, wait. Used to abort between create and the checkpoint. */
  holdCreate: ((signal: AbortSignal) => Promise<void>) | null = null;
  /** When set, createReview throws this before writing. */
  createError: Error | null = null;
  /** GitHub forbids REQUEST_CHANGES when the token user opened the pull request. */
  rejectOwnRequestChanges = false;
  /** resolveReviewThread throws, so the publisher replies instead. */
  failResolve = false;
  #next = 1;

  async getPullDiff(): Promise<string> {
    this.calls.push("getPullDiff");
    return FIXTURE_DIFF;
  }

  async listIssueComments(): Promise<IssueComment[]> {
    this.calls.push("listIssueComments");
    return this.comments.map((comment) => ({ ...comment }));
  }

  async createIssueComment(_request: ReviewRequest, body: string): Promise<IssueComment> {
    this.calls.push("createIssueComment");
    const comment = { id: this.#next++, body };
    this.comments.push(comment);
    return { ...comment };
  }

  async updateIssueComment(_request: ReviewRequest, commentId: number, body: string): Promise<IssueComment> {
    this.calls.push("updateIssueComment");
    const comment = this.comments.find((item) => item.id === commentId);
    if (!comment) throw new Error(`comment ${commentId} not found`);
    comment.body = body;
    return { ...comment };
  }

  async listReviews(): Promise<PullReview[]> {
    this.calls.push("listReviews");
    return this.reviews.map((review) => ({ id: review.id, body: review.body }));
  }

  async createReview(
    _request: ReviewRequest,
    review: { sha: string; body: string; event?: ReviewEvent; comments: ReviewCommentDraft[] },
  ): Promise<PullReview> {
    this.calls.push("createReview");
    if (this.createError) throw this.createError;
    const event = review.event ?? "COMMENT";
    if (event === "REQUEST_CHANGES" && this.rejectOwnRequestChanges) {
      throw new RequestChangesRejectedError("Can not request changes on your own pull request");
    }
    const id = this.#next++;
    const created = { id, body: review.body, event, comments: review.comments };
    this.reviews.push(created);
    for (const comment of review.comments) {
      const commentId = this.#next++;
      this.reviewComments.push({
        id: commentId,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        threadId: `PRRT_${commentId}`,
        inReplyToId: null,
        reviewId: id,
        resolved: false,
      });
    }
    return { id, body: review.body };
  }

  async listReviewComments(): Promise<PullReviewComment[]> {
    this.calls.push("listReviewComments");
    return this.reviewComments.map((comment) => ({ ...comment }));
  }

  async resolveReviewThread(_request: ReviewRequest, threadId: string): Promise<void> {
    this.calls.push("resolveReviewThread");
    if (this.failResolve) throw new Error("resolveReviewThread failed");
    const matched = this.reviewComments.filter((comment) => comment.threadId === threadId);
    if (matched.length === 0) throw new Error(`thread ${threadId} not found`);
    for (const comment of matched) comment.resolved = true;
  }

  async replyToReviewComment(
    _request: ReviewRequest,
    commentId: number,
    body: string,
  ): Promise<PullReviewComment> {
    this.calls.push("replyToReviewComment");
    const parent = this.reviewComments.find((comment) => comment.id === commentId);
    if (!parent) throw new Error(`comment ${commentId} not found`);
    const reply: PullReviewComment = {
      id: this.#next++,
      body,
      path: parent.path,
      line: parent.line,
      threadId: parent.threadId,
      inReplyToId: parent.id,
      reviewId: parent.reviewId,
      resolved: parent.resolved,
    };
    this.reviewComments.push(reply);
    return { ...reply };
  }

  /** Paths passed to `getRepoFile`, in call order. */
  filePaths: string[] = [];

  async getRepoFile(_request: GitHubRepo, path: string, ref: string): Promise<string | null> {
    this.calls.push("getRepoFile");
    this.fileRefs.push(ref);
    this.filePaths.push(path);
    return this.files.get(`${ref}\0${path}`) ?? null;
  }

  async viewerLogin(): Promise<string> {
    this.calls.push("viewerLogin");
    return this.viewer;
  }

  async collaboratorPermission(_request: GitHubRepo, username: string): Promise<string> {
    this.calls.push("collaboratorPermission");
    return this.permissions.get(username) ?? "none";
  }

  async getPull(): Promise<RemotePull> {
    this.calls.push("getPull");
    if (!this.remotePull) throw new Error("pull is not configured");
    return { ...this.remotePull };
  }

  async reactToComment(_request: GitHubRepo, commentId: number): Promise<void> {
    this.calls.push("reactToComment");
    this.reactions.push({ commentId, content: "eyes" });
  }

  /** Files returned by `listPullFiles`. Empty until a test sets them. */
  pullFiles: PullFile[] = [];
  pullFileRequests: Array<{ installationId: number | null; number: number }> = [];
  /** When set, `listPullFiles` throws this instead of returning `pullFiles`. */
  pullFilesError: Error | null = null;

  async listPullFiles(request: GitHubRepo & { number: number }): Promise<PullFile[]> {
    this.calls.push("listPullFiles");
    this.pullFileRequests.push({ installationId: request.installationId, number: request.number });
    if (this.pullFilesError) throw this.pullFilesError;
    return this.pullFiles.map((file) => ({ ...file }));
  }

  async listCheckRuns(_request: GitHubRepo, sha: string, name: string): Promise<CheckRun[]> {
    this.calls.push("listCheckRuns");
    this.#rejectChecks("GET", `/repos/${_request.owner}/${_request.repo}/commits/${sha}/check-runs`);
    return this.checkRuns
      .filter((run) => run.sha === sha && run.name === name)
      .map((run) => ({ id: run.id, status: run.status, conclusion: run.conclusion, externalId: run.externalId }));
  }

  async createCheckRun(
    request: GitHubRepo,
    input: { name: string; sha: string; externalId: string },
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CheckRun> {
    this.calls.push("createCheckRun");
    this.#rejectChecks("POST", `/repos/${request.owner}/${request.repo}/check-runs`);
    const run: MemoryCheckRun = {
      id: this.#next++,
      name: input.name,
      sha: input.sha,
      status: "in_progress",
      conclusion: null,
      externalId: input.externalId,
      title: null,
      summary: null,
      detailsUrl: null,
    };
    this.checkRuns.push(run);
    this.checkLog.push({ ...run });
    if (this.holdCreate) await this.holdCreate(signal);
    return { id: run.id, status: run.status, conclusion: null, externalId: run.externalId };
  }

  async updateCheckRun(
    request: GitHubRepo,
    checkRunId: number,
    input: { conclusion: CheckConclusion; title: string; summary: string; detailsUrl?: string },
  ): Promise<CheckRun> {
    this.calls.push("updateCheckRun");
    if (this.checkUpdateFailures > 0) {
      this.checkUpdateFailures -= 1;
      throw new Error(
        `GitHub PATCH /repos/${request.owner}/${request.repo}/check-runs/${checkRunId} failed (500): temporary`,
      );
    }
    this.#rejectChecks("PATCH", `/repos/${request.owner}/${request.repo}/check-runs/${checkRunId}`);
    const run = this.checkRuns.find((item) => item.id === checkRunId);
    if (!run) throw new Error(`check run ${checkRunId} not found`);
    run.status = "completed";
    run.conclusion = input.conclusion;
    run.title = input.title;
    run.summary = input.summary;
    if (input.detailsUrl) run.detailsUrl = input.detailsUrl;
    this.checkLog.push({ ...run });
    return { id: run.id, status: run.status, conclusion: run.conclusion, externalId: run.externalId };
  }

  #rejectChecks(method: string, path: string): void {
    if (this.checkErrorStatus === null) return;
    throw new Error(`GitHub ${method} ${path} failed (${this.checkErrorStatus}): Resource not accessible by integration`);
  }
}

export type MemoryCheckRun = {
  id: number;
  name: string;
  sha: string;
  status: "in_progress" | "completed";
  conclusion: CheckConclusion | null;
  externalId: string | null;
  title: string | null;
  summary: string | null;
  detailsUrl: string | null;
};

export class FixtureCheckout implements RepoCheckout {
  async prepare(): Promise<Checkout> {
    const loaded = await loadDureviewFile(FIXTURE_DIR);
    return {
      dir: FIXTURE_DIR,
      diff: FIXTURE_DIFF,
      truncated: false,
      rules: loaded.rules,
      policy: loaded.policy,
    };
  }
}

export function testConfig(dataDir: string): Config {
  return {
    dataDir,
    host: "127.0.0.1",
    port: 0,
    webhookSecret: SECRET,
    provider: "openai-codex",
    modelId: "faux-1",
    thinking: "off",
    githubToken: "test-token",
    githubAppId: undefined,
    githubAppPrivateKey: undefined,
    githubApiUrl: "https://api.github.com",
    skipDrafts: false,
    uiToken: undefined,
    defaultTrigger: "manual",
    checkoutTtlDays: 30,
  };
}

export async function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dureview-"));
}

export async function openTestService(options: {
  dataDir: string;
  github: MemoryGitHub;
  responses?: FauxResponseStep[];
  hooks?: ReviewHooks;
  checkout?: RepoCheckout;
  skipDrafts?: boolean;
  defaultTrigger?: Config["defaultTrigger"];
}) {
  const faux = fauxProvider();
  faux.setResponses(options.responses ?? []);
  const models = createModels();
  models.setProvider(faux.provider);
  const config = testConfig(options.dataDir);
  if (options.skipDrafts) config.skipDrafts = true;
  if (options.defaultTrigger) config.defaultTrigger = options.defaultTrigger;
  const service = await DureviewService.open({
    config,
    models,
    github: options.github,
    checkout: options.checkout ?? new FixtureCheckout(),
    provider: "faux",
    modelId: "faux-1",
    hooks: options.hooks,
  });
  return { service, faux };
}

export function hangUntilAbort(context: Context): Promise<void> {
  const signal = context.abortSignal;
  if (!signal) return Promise.reject(new Error("review invocation has no abort signal"));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}
