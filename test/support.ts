import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { Config } from "../src/config.js";
import type { GitHub, IssueComment, PullReview, ReviewCommentDraft } from "../src/github/client.js";
import type { Checkout, RepoCheckout } from "../src/review/checkout.js";
import { readRules } from "../src/review/checkout.js";
import type { ReviewHooks } from "../src/review/task.js";
import { DureviewService } from "../src/service.js";
import type { Finding, ReviewRequest } from "../src/types.js";

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

export const FINDING: Finding = {
  path: "src/pay.ts",
  line: 2,
  body: "Positive amounts return success without capturing the charge, so the customer is never billed.",
};

export function reviewRequest(sha = SHA_A): ReviewRequest {
  return {
    owner: "acme",
    repo: "demo",
    number: 7,
    sha,
    baseSha: BASE_SHA,
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
      base: { sha: BASE_SHA },
    },
  };
}

export function scriptedReview(summary: string, findings: Finding[] = [FINDING]): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall("read", { path: "src/pay.ts" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("grep", { pattern: "capture" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_review", { summary, findings }), { stopReason: "toolUse" }),
  ];
}

export class MemoryGitHub implements GitHub {
  comments: IssueComment[] = [];
  reviews: Array<PullReview & { comments: ReviewCommentDraft[] }> = [];
  #next = 1;

  async getPullDiff(): Promise<string> {
    return FIXTURE_DIFF;
  }

  async listIssueComments(): Promise<IssueComment[]> {
    return this.comments.map((comment) => ({ ...comment }));
  }

  async createIssueComment(_request: ReviewRequest, body: string): Promise<IssueComment> {
    const comment = { id: this.#next++, body };
    this.comments.push(comment);
    return { ...comment };
  }

  async updateIssueComment(_request: ReviewRequest, commentId: number, body: string): Promise<IssueComment> {
    const comment = this.comments.find((item) => item.id === commentId);
    if (!comment) throw new Error(`comment ${commentId} not found`);
    comment.body = body;
    return { ...comment };
  }

  async listReviews(): Promise<PullReview[]> {
    return this.reviews.map((review) => ({ id: review.id, body: review.body }));
  }

  async createReview(
    _request: ReviewRequest,
    review: { sha: string; body: string; comments: ReviewCommentDraft[] },
  ): Promise<PullReview> {
    const created = { id: this.#next++, body: review.body, comments: review.comments };
    this.reviews.push(created);
    return { id: created.id, body: created.body };
  }
}

export class FixtureCheckout implements RepoCheckout {
  async prepare(): Promise<Checkout> {
    return {
      dir: FIXTURE_DIR,
      diff: FIXTURE_DIFF,
      truncated: false,
      rules: await readRules(FIXTURE_DIR),
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
}) {
  const faux = fauxProvider();
  faux.setResponses(options.responses ?? []);
  const models = createModels();
  models.setProvider(faux.provider);
  const service = await DureviewService.open({
    config: testConfig(options.dataDir),
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
