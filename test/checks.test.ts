import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { GithubRest } from "../src/github/client.js";
import { REVIEW_CHECK_NAME, reviewCheckError, reviewCheckOutcome } from "../src/review/checks.js";
import type { RepoCheckout } from "../src/review/checkout.js";
import { defaultPolicy, type ReviewPolicy } from "../src/review/policy.js";
import {
  FINDING,
  FIXTURE_DIFF,
  FIXTURE_DIR,
  MemoryGitHub,
  openTestService,
  reviewRequest,
  sampleFinding,
  scriptedReview,
  SECRET,
  SHA_A,
  tempDataDir,
  testConfig,
} from "./support.js";

describe("check conclusions", () => {
  const diff = FIXTURE_DIFF;
  const policy = defaultPolicy();

  it("reports no findings in English and Chinese", () => {
    expect(reviewCheckOutcome({ findings: [], diff, policy })).toEqual({
      conclusion: "success",
      title: "No findings",
      summary: "No issues to report.",
    });
    expect(reviewCheckOutcome({ findings: [], diff, policy: { ...policy, language: "zh" } })).toEqual({
      conclusion: "success",
      title: "未发现问题",
      summary: "没有需要处理的问题。",
    });
  });

  it("fails on a P0 or P1 and lists every priority", () => {
    const findings = [
      sampleFinding({ priority: 0, title: "Double capture", confidence: 0.95 }),
      sampleFinding({ priority: 1, title: "Missing amount check" }),
      sampleFinding({ priority: 2, title: "Weak retry", confidence: 0.8 }),
    ];
    expect(reviewCheckOutcome({ findings, diff, policy })).toEqual({
      conclusion: "failure",
      title: "Blocking findings",
      summary: "P0: 1\nP1: 1\nP2: 1\nP3: 0",
    });
    expect(reviewCheckOutcome({ findings, diff, policy: { ...policy, language: "zh" } }).summary).toBe(
      "P0：1\nP1：1\nP2：1\nP3：0",
    );
  });

  it("succeeds with a suggestion title when only P2 and P3 remain", () => {
    const one = [sampleFinding({ priority: 2, title: "Name the timeout", confidence: 0.8 })];
    expect(reviewCheckOutcome({ findings: one, diff, policy })).toMatchObject({
      conclusion: "success",
      title: "1 suggestion",
    });
    const several = [
      sampleFinding({ priority: 2, title: "Name the timeout", confidence: 0.8 }),
      sampleFinding({ priority: 3, title: "Log the amount", confidence: 0.6 }),
      sampleFinding({ priority: 3, title: "Comment the branch", confidence: 0.6 }),
    ];
    expect(reviewCheckOutcome({ findings: several, diff, policy: { ...policy, language: "zh" } })).toMatchObject({
      conclusion: "success",
      title: "有 3 条建议",
      summary: "P0：0\nP1：0\nP2：1\nP3：2",
    });
  });

  it("ignores findings the review drops, and still counts a P0 that is not inlined", () => {
    const dropped = sampleFinding({ priority: 0, title: "Too unsure", confidence: 0.1 });
    expect(reviewCheckOutcome({ findings: [dropped], diff, policy }).conclusion).toBe("success");
    const ignored = sampleFinding({ priority: 1, title: "Generated", path: "dist/app.js", confidence: 0.9 });
    expect(reviewCheckOutcome({ findings: [ignored], diff, policy }).title).toBe("No findings");
    const outside = sampleFinding({ priority: 0, title: "Off the diff", startLine: 99, endLine: 99, confidence: 0.9 });
    expect(reviewCheckOutcome({ findings: [outside], diff, policy })).toMatchObject({
      conclusion: "failure",
      summary: "P0: 1\nP1: 0\nP2: 0\nP3: 0",
    });
    const suspected = sampleFinding({
      priority: 0,
      kind: "investigate",
      trigger: "",
      title: "Maybe billed twice",
      confidence: 0.8,
    });
    expect(reviewCheckOutcome({ findings: [suspected], diff, policy }).conclusion).toBe("failure");
  });

  it("fails the check on a timeout or model error, and asks for action on bad configuration", () => {
    expect(reviewCheckError("Review run did not finish: timeout", "en")).toEqual({
      conclusion: "failure",
      title: "Review failed",
      summary: "Review run did not finish: timeout",
    });
    expect(reviewCheckError("The model finished without calling submit_review.", "zh")).toMatchObject({
      conclusion: "failure",
      title: "审查失败",
    });
    expect(reviewCheckError("Unknown model faux/missing.", "zh")).toEqual({
      conclusion: "action_required",
      title: "需要处理",
      summary: "Unknown model faux/missing.",
    });
    expect(reviewCheckError(".dureview.md profile must be quiet, default, or loud, got noisy.", "en")).toMatchObject({
      conclusion: "action_required",
      title: "Action required",
    });
  });
});

describe("check run on a review", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("opens an in-progress check and completes it when nothing is wrong", async () => {
    const { github, service } = await start({
      responses: scriptedReview("Nothing to bill twice.", []),
      checkout: policyCheckout({ language: "zh" }),
    });
    const settled = await run(service);
    expect(settled.state.outcome.status).toBe("completed");
    expect(github.comments).toHaveLength(0);
    expect(github.reviews).toHaveLength(0);
    expect(github.checkLog.map((run) => run.status)).toEqual(["in_progress", "completed"]);
    expect(github.checkRuns).toEqual([
      expect.objectContaining({
        name: REVIEW_CHECK_NAME,
        sha: SHA_A,
        status: "completed",
        conclusion: "success",
        title: "未发现问题",
        summary: "没有需要处理的问题。",
      }),
    ]);
  });

  it("fails the check on P0 or P1 and still requests changes", async () => {
    const findings = [
      sampleFinding({ priority: 0, title: "Double capture", confidence: 0.95 }),
      FINDING,
      sampleFinding({ priority: 2, title: "Name the timeout", confidence: 0.8 }),
    ];
    const { github, service } = await start({
      responses: scriptedReview("Billing can be skipped.", findings),
      checkout: policyCheckout(),
    });
    const settled = await run(service);
    expect(settled.state.outcome.status).toBe("completed");
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]?.event).toBe("REQUEST_CHANGES");
    expect(github.checkRuns[0]).toMatchObject({
      conclusion: "failure",
      title: "Blocking findings",
      summary: "P0: 1\nP1: 1\nP2: 1\nP3: 0",
    });
  });

  it("succeeds with a suggestion count when the review only has P2 and P3", async () => {
    const findings = [
      sampleFinding({ priority: 2, title: "Name the timeout", confidence: 0.8 }),
      sampleFinding({ priority: 2, title: "Bound the retry", confidence: 0.85 }),
      sampleFinding({ priority: 3, title: "Log the amount", confidence: 0.6 }),
    ];
    const { github, service } = await start({
      responses: scriptedReview("A few suggestions.", findings),
      checkout: policyCheckout({ language: "zh" }),
    });
    const settled = await run(service);
    expect(settled.state.outcome.status).toBe("completed");
    expect(github.reviews[0]?.event).toBe("COMMENT");
    expect(github.checkRuns[0]).toMatchObject({
      conclusion: "success",
      title: "有 3 条建议",
      summary: "P0：0\nP1：0\nP2：2\nP3：1",
    });
  });

  it("completes the check as failure when the model never submits", async () => {
    const { github, service } = await start({
      responses: [
        fauxAssistantMessage("I am done.", { stopReason: "stop" }),
        fauxAssistantMessage("Still done.", { stopReason: "stop" }),
      ],
      checkout: policyCheckout({ language: "zh" }),
    });
    const settled = await run(service);
    expect(settled.state.outcome.status).toBe("failed");
    expect(github.checkRuns).toHaveLength(1);
    expect(github.checkRuns[0]).toMatchObject({
      status: "completed",
      conclusion: "failure",
      title: "审查失败",
    });
    expect(github.checkRuns[0]?.summary).toContain("submit_review");
    expect(github.checkLog.at(-1)?.status).toBe("completed");
  });

  it("marks configuration errors as action required instead of leaving the check running", async () => {
    const checkout: RepoCheckout = {
      async prepare() {
        throw new Error(".dureview.md profile must be quiet, default, or loud, got noisy.");
      },
    };
    const { github, service } = await start({ checkout, responses: [] });
    const settled = await run(service);
    expect(settled.state.outcome.status).toBe("failed");
    expect(github.checkRuns[0]).toMatchObject({
      status: "completed",
      conclusion: "action_required",
      title: "Action required",
    });
    expect(github.checkRuns[0]?.summary).toContain(".dureview.md");
  });

  it("keeps reviewing when the Checks API returns 403", async () => {
    const github = new MemoryGitHub();
    github.checkErrorStatus = 403;
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      const { service } = await start({
        github,
        responses: scriptedReview("Billing can be skipped."),
        checkout: policyCheckout(),
      });
      const settled = await run(service);
      expect(settled.state.outcome.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]?.event).toBe("REQUEST_CHANGES");
    expect(github.checkRuns).toHaveLength(0);
    expect(lines.some((line) => line.includes("cannot write check runs"))).toBe(true);
  });

  it("keeps reviewing when the Checks API fails for another reason", async () => {
    const github = new MemoryGitHub();
    github.checkErrorStatus = 500;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line) => {
      errors.push(String(line));
    });
    try {
      const { service } = await start({
        github,
        responses: scriptedReview("Nothing to bill twice.", []),
        checkout: policyCheckout(),
      });
      const settled = await run(service);
      expect(settled.state.outcome.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
    expect(github.checkRuns).toHaveLength(0);
    expect(errors.some((line) => line.includes("Could not create the dureview check run"))).toBe(true);
  });

  it("does not open a second check for the same head, and does open one for /dureview", async () => {
    const github = new MemoryGitHub();
    github.remotePull = {
      number: 7,
      title: "Charge positive amounts",
      draft: false,
      sha: SHA_A,
      baseSha: "1111111111111111111111111111111111111111",
      baseRef: "main",
    };
    github.permissions.set("alice", "write");
    const { service } = await start({
      github,
      responses: [...scriptedReview("First pass.", []), ...scriptedReview("Asked again.", [])],
      checkout: policyCheckout(),
    });
    const first = await service.enqueue(reviewRequest());
    const second = await service.enqueue(reviewRequest());
    expect(second.deduped).toBe(true);
    expect(second.taskId).toBe(first.taskId);
    await service.wait(first.taskId);
    expect(github.checkRuns).toHaveLength(1);

    const response = await deliver(service, comment("/dureview", 8));
    expect(response.status).toBe(202);
    expect(response.body.deduped).toBe(false);
    await service.wait(response.body.taskId as never);
    expect(github.checkRuns).toHaveLength(2);
    expect(github.checkRuns.every((run) => run.name === REVIEW_CHECK_NAME && run.sha === SHA_A)).toBe(true);
    expect(github.checkRuns.every((run) => run.conclusion === "success")).toBe(true);
  });

  it("reuses the in-progress check when the process stops during checkout", async () => {
    const github = new MemoryGitHub();
    const dataDir = await tempDataDir();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hanging: RepoCheckout = {
      prepare: (_request, signal) =>
        new Promise((_resolve, reject) => {
          markStarted();
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        }),
    };
    const first = await openTestService({ dataDir, github, checkout: hanging, responses: [] });
    closers.push(() => first.service.close());
    const queued = await first.service.enqueue(reviewRequest());
    await started;
    expect(github.checkRuns).toHaveLength(1);
    expect(github.checkRuns[0]?.status).toBe("in_progress");
    await first.service.close();
    closers.pop();

    const second = await openTestService({
      dataDir,
      github,
      responses: scriptedReview("Nothing to bill twice.", []),
      checkout: policyCheckout({ language: "zh" }),
    });
    closers.push(() => second.service.close());
    const settled = await second.service.wait(queued.taskId);
    expect(settled.state.outcome.status).toBe("completed");
    expect(github.checkRuns).toHaveLength(1);
    expect(github.calls.filter((call) => call === "createCheckRun")).toEqual(["createCheckRun"]);
    expect(github.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "success", title: "未发现问题" });
  });

  async function start(options: {
    github?: MemoryGitHub;
    responses?: Parameters<typeof openTestService>[0]["responses"];
    checkout?: RepoCheckout;
  }) {
    const github = options.github ?? new MemoryGitHub();
    const opened = await openTestService({
      dataDir: await tempDataDir(),
      github,
      responses: options.responses ?? [],
      checkout: options.checkout,
    });
    closers.push(() => opened.service.close());
    return { github, service: opened.service };
  }

  async function run(service: Awaited<ReturnType<typeof openTestService>>["service"]) {
    const queued = await service.enqueue(reviewRequest());
    return service.wait(queued.taskId);
  }
});

describe("Checks API payload", () => {
  it("creates an in-progress run on the head SHA and completes it", async () => {
    const client = new GithubRest(testConfig(await tempDataDir()));
    const bodies: unknown[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST" || method === "PATCH") bodies.push(JSON.parse(String(init?.body)));
      if (method === "POST") {
        return Response.json({ id: 11, status: "in_progress", external_id: "4", conclusion: null });
      }
      if (method === "PATCH") {
        return Response.json({ id: 11, status: "completed", conclusion: "success", external_id: "4" });
      }
      expect(String(url)).toContain(`/commits/${SHA_A}/check-runs`);
      expect(String(url)).toContain("check_name=dureview");
      return Response.json({
        total_count: 1,
        check_runs: [{ id: 11, status: "in_progress", external_id: "4", conclusion: null, name: "dureview" }],
      });
    });
    try {
      const signal = new AbortController().signal;
      const request = reviewRequest();
      const listed = await client.listCheckRuns(request, SHA_A, "dureview", signal);
      expect(listed).toEqual([{ id: 11, status: "in_progress", conclusion: null, externalId: "4" }]);
      const created = await client.createCheckRun(
        request,
        { name: "dureview", sha: request.sha, externalId: "4" },
        signal,
      );
      expect(created.id).toBe(11);
      expect(bodies[0]).toMatchObject({
        name: "dureview",
        head_sha: SHA_A,
        status: "in_progress",
        external_id: "4",
      });
      expect(typeof (bodies[0] as { started_at?: string }).started_at).toBe("string");
      await client.updateCheckRun(
        request,
        11,
        { conclusion: "success", title: "No findings", summary: "No issues to report." },
        signal,
      );
      expect(bodies[1]).toMatchObject({
        status: "completed",
        conclusion: "success",
        output: { title: "No findings", summary: "No issues to report." },
      });
      expect(typeof (bodies[1] as { completed_at?: string }).completed_at).toBe("string");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

function policyCheckout(overrides: Partial<ReviewPolicy> = {}): RepoCheckout {
  return {
    async prepare() {
      return {
        dir: FIXTURE_DIR,
        diff: FIXTURE_DIFF,
        truncated: false,
        rules: null,
        policy: { ...defaultPolicy(), summary: false, ...overrides },
      };
    },
  };
}

function comment(body: string, commentId: number): Record<string, unknown> {
  return {
    action: "created",
    installation: { id: 99 },
    repository: {
      name: "demo",
      clone_url: "https://github.com/acme/demo.git",
      owner: { login: "acme" },
    },
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/acme/demo/pulls/7" } },
    comment: { id: commentId, body, user: { login: "alice" } },
  };
}

function deliver(
  service: { handleWebhook(raw: Buffer, signature: string | undefined, event: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> },
  payload: Record<string, unknown>,
) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  return service.handleWebhook(raw, signature, "issue_comment");
}
