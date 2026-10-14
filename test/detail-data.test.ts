import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewArchive } from "../src/review/archive.js";
import type { ReviewDetail, StoredComment } from "../src/review/archive.js";
import { defaultPolicy } from "../src/review/policy.js";
import { buildReviewDetail, loadReviewDetail } from "../src/ui/detail-data.js";
import { safeNextPath } from "../src/ui/next-path.js";
import { STUCK_AFTER_MS } from "../src/ui/page.js";
import { BASE_SHA, MemoryGitHub, openTestService, sampleFinding, SHA_A, tempDataDir } from "./support.js";

const PATCH = [
  "@@ -1,5 +1,6 @@",
  " export function charge(amount: number): { ok: boolean } {",
  "-  return gateway.capture(amount);",
  "+  if (amount > 0) return { ok: true };",
  "+  return gateway.capture(amount);",
  " }",
].join("\n");

describe("review detail loader", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("places a live diff comment and keeps the full sha out of the view", async () => {
    const dataDir = await tempDataDir();
    const archive = new ReviewArchive(join(dataDir, "reviews.sqlite"));
    await archive.open();
    await archive.start({
      taskId: "4",
      owner: "acme",
      repo: "demo",
      number: 7,
      title: "Charge positive amounts",
      sha: SHA_A,
      baseSha: BASE_SHA,
      baseRef: "main",
      installationId: 99,
      trigger: "opened",
    });
    await archive.finish({
      taskId: "4",
      owner: "acme",
      repo: "demo",
      number: 7,
      outcome: "completed",
      verdict: "block",
      findingCount: 1,
      title: "Charge positive amounts",
      sha: SHA_A,
      baseSha: BASE_SHA,
      baseRef: "main",
      installationId: 99,
      verdictReason: "Do not merge.",
      overallConfidence: 0.8,
      checked: ["payment capture"],
      policy: { ...defaultPolicy(), trigger: "auto" },
      findings: [sampleFinding({ title: "<b>xss</b>", suggestion: "return gateway.capture(amount);" })],
      provider: "faux",
      modelId: "faux-1",
    });
    archive.close();

    const github = new MemoryGitHub();
    github.pullFiles = [
      {
        filename: "src/pay.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: PATCH,
        previousFilename: null,
      },
    ];
    const { service } = await openTestService({ dataDir, github, responses: [] });
    closers.push(() => service.close());

    expect(await service.reviewExists("4")).toBe(true);
    expect(await service.reviewExists("missing")).toBe(false);
    expect(await service.reviewExists("../secret")).toBe(false);

    const model = await loadReviewDetail(service, "https://api.github.com", "4", Date.parse("2026-10-13T15:05:00.000Z"));
    expect(model).not.toBeNull();
    if (!model) return;
    const pay = model.files.find((file) => file.filename === "src/pay.ts");
    const anchored = pay?.lines.find((line) => line.comments.length > 0);
    expect(anchored?.newLabel).toBe("2");
    expect(anchored?.severity).toBe(1);
    expect(anchored?.comments[0]?.title).toBe("<b>xss</b>");
    expect(anchored?.comments[0]?.suggestion).toBe("return gateway.capture(amount);");
    expect(model.pullHref).toBe("https://github.com/acme/demo/pull/7");
    expect(model.diffUnavailable).toBe(false);
    expect(model.summary.mode).toBe("complete");
    if (model.summary.mode === "complete") {
      expect(model.summary.counts.map((count) => [count.label, count.value, count.on])).toEqual([
        ["P0", "0", false],
        ["P1", "1", true],
        ["P2", "0", false],
        ["P3", "0", false],
      ]);
      expect(model.summary.reason).toBe("Do not merge.");
    }
    expect(model.settings.recorded).toBe(true);
    if (model.settings.recorded) {
      expect(model.settings.rows.find((row) => row.key === "trigger")?.value).toBe("auto");
      expect(model.settings.rows.find((row) => row.key === "head")?.value).toBe(SHA_A.slice(0, 7));
    }
    expect(github.pullFileRequests).toEqual([{ installationId: 99, number: 7 }]);
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(SHA_A);
    expect(serialized).not.toContain(BASE_SHA);
    expect(serialized).not.toContain("installationId");

    github.pullFilesError = new Error("GitHub 500 TOKEN_SHOULD_NOT_LEAK");
    const failedDiff = await loadReviewDetail(service, "https://api.github.com", "4");
    expect(failedDiff?.diffUnavailable).toBe(true);
    expect(failedDiff?.files).toEqual([]);
    expect(failedDiff?.outside.map((comment) => comment.title)).toEqual(["<b>xss</b>"]);
    expect(failedDiff?.outsideTitle).toBe("Other files");
    expect(JSON.stringify(failedDiff)).not.toContain("TOKEN_SHOULD_NOT_LEAK");
    expect(await loadReviewDetail(service, "https://api.github.com", "missing")).toBeNull();
    expect(await loadReviewDetail(service, "https://api.github.com", "../secret")).toBeNull();
  });

  it("shows running, stuck, and a missing error reason without priority counts", () => {
    const now = Date.parse("2026-10-13T16:00:00.000Z");
    const running = detail([]);
    running.outcome = "running";
    running.verdict = null;
    running.finishedAt = null;
    running.startedAt = new Date(now - 5 * 60 * 1000).toISOString();
    const fresh = buildReviewDetail({
      review: running,
      files: [],
      diffUnavailable: false,
      githubApiUrl: "https://api.github.com",
      now,
    });
    expect(fresh.duration).toBe("进行中");
    expect(fresh.summary).toMatchObject({ mode: "incomplete", note: "进行中" });
    expect(fresh.noChangedFiles).toBe(true);

    running.startedAt = new Date(now - STUCK_AFTER_MS).toISOString();
    const stuck = buildReviewDetail({
      review: running,
      files: [],
      diffUnavailable: false,
      githubApiUrl: "https://api.github.com",
      now,
    });
    expect(stuck.duration).toBe("疑似卡住");
    expect(stuck.summary).toMatchObject({ mode: "incomplete", note: "疑似卡住" });

    const failed = detail([]);
    failed.outcome = "failed";
    failed.verdict = null;
    failed.error = null;
    failed.checked = ["payment capture"];
    const broken = buildReviewDetail({
      review: failed,
      files: [],
      diffUnavailable: true,
      githubApiUrl: "https://api.github.com",
      now,
    });
    expect(broken.summary).toMatchObject({ mode: "incomplete", note: "审查失败，没有记录原因。" });
    expect(broken.diffUnavailable).toBe(true);
    expect(JSON.stringify(broken.summary)).not.toContain("payment capture");
  });

  it("caps the file list and sends a login on / to /ui", () => {
    const files = Array.from({ length: 201 }, (_, index) => ({
      filename: `src/f${String(index).padStart(3, "0")}.ts`,
      status: "added",
      additions: 1,
      deletions: 0,
      patch: "@@ -0,0 +1 @@\n+ok\n",
      previousFilename: null,
    }));
    const model = buildReviewDetail({
      review: detail([]),
      files,
      diffUnavailable: false,
      githubApiUrl: "https://api.github.com",
    });
    expect(model.files).toHaveLength(200);
    expect(model.hiddenFiles).toBe(1);
    expect(model.files[0]?.statusMark).toBe("A");

    expect(safeNextPath("/")).toBe("/ui");
    expect(safeNextPath("/?q=pay")).toBe("/ui");
    expect(safeNextPath("/ui")).toBe("/ui");
    expect(safeNextPath("/ui/stats")).toBe("/ui/stats");
    expect(safeNextPath("/ui/reviews/task_1")).toBe("/ui/reviews/task_1");
    expect(safeNextPath("https://evil.example/phish")).toBe("/ui");
  });
});

function detail(comments: StoredComment[]): ReviewDetail {
  return {
    taskId: "4",
    owner: "acme",
    repo: "demo",
    number: 7,
    title: "Charge positive amounts",
    trigger: "opened",
    startedAt: "2026-10-13T15:04:00.000Z",
    finishedAt: "2026-10-13T15:05:00.000Z",
    outcome: "completed",
    verdict: "clean",
    p0: 0,
    p1: 0,
    p2: 0,
    p3: 0,
    findingCount: comments.length,
    countsKnown: true,
    sha: SHA_A,
    baseSha: BASE_SHA,
    baseRef: "main",
    installationId: 99,
    verdictReason: null,
    overallConfidence: null,
    checked: [],
    provider: "faux",
    model: "faux-1",
    policy: {
      profile: "default",
      trigger: "manual",
      drafts: false,
      language: "en",
      summary: false,
      minConfidence: 0.5,
      minInlinePriority: 2,
      p2InlineMinConfidence: 0.7,
      maxInline: 10,
    },
    comments,
    error: null,
  };
}
