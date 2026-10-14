import { describe, expect, it } from "vitest";
import { reviewResult, type ReviewDetail, type StoredComment } from "../src/review/archive.js";
import { buildReviewDetail } from "../src/ui/detail-data.js";
import { gitDiffText, parsePatch, placeReview } from "../src/ui/diff.js";
import { parseReviewPatch } from "../src/ui/review-presentation.js";
import type { ReviewListModel } from "../src/ui/list-model.js";
import { displayTrigger, formatTime, resultLabel, runningLabel, STUCK_AFTER_MS } from "../src/ui/page.js";
import { renderDetailHtml, renderListHtml } from "../src/ui/render-react.js";
import { sampleFinding } from "./support.js";

const PATCH = [
  "@@ -1,5 +1,6 @@",
  " export function charge(amount: number): { ok: boolean } {",
  "-  return gateway.capture(amount);",
  "+  if (amount > 0) return { ok: true };",
  "+  return gateway.capture(amount);",
  " }",
].join("\n");

describe("pull request diff placement", () => {
  it("parses head line numbers and anchors a comment on the end line", () => {
    const lines = parsePatch(PATCH);
    expect(lines.map((line) => [line.kind, line.newLine, line.text])).toEqual([
      ["hunk", null, "@@ -1,5 +1,6 @@"],
      ["context", 1, "export function charge(amount: number): { ok: boolean } {"],
      ["del", null, "  return gateway.capture(amount);"],
      ["add", 2, "  if (amount > 0) return { ok: true };"],
      ["add", 3, "  return gateway.capture(amount);"],
      ["context", 4, "}"],
    ]);

    const comment = stored(sampleFinding({ startLine: 2, endLine: 2, priority: 1 }));
    const placed = placeReview(
      [
        {
          filename: "src/pay.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: PATCH,
          previousFilename: null,
        },
        {
          filename: "README.md",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+hello\n",
          previousFilename: null,
        },
      ],
      [comment, stored(sampleFinding({ path: "missing.ts", startLine: 1, endLine: 1, priority: 3, title: "Elsewhere" }))],
    );
    const pay = placed.files.find((file) => file.filename === "src/pay.ts");
    const anchored = pay?.lines.find((line) => line.comments.length > 0);
    expect(anchored?.newLine).toBe(2);
    expect(anchored?.severity).toBe(1);
    expect(pay?.lines.filter((line) => line.severity === 1).map((line) => line.newLine)).toEqual([2]);
    expect(placed.outside.map((item) => item.path)).toEqual(["missing.ts"]);
    expect(placed.files.map((file) => file.filename)).toEqual(["README.md", "src/pay.ts"]);
  });

  it("keeps a comment whose line is outside the patch", () => {
    const placed = placeReview(
      [
        {
          filename: "src/pay.ts",
          status: "modified",
          additions: 0,
          deletions: 0,
          patch: null,
          previousFilename: null,
        },
      ],
      [stored(sampleFinding())],
    );
    expect(placed.files[0]?.patchMissing).toBe(true);
    expect(placed.files[0]?.unanchored).toHaveLength(1);
  });

  it("wraps a GitHub hunk as a git diff without moving the start line", () => {
    const diffText = gitDiffText({
      filename: "src/pay.ts",
      previousFilename: null,
      status: "modified",
      patch: PATCH,
    });
    expect(diffText).toContain("diff --git a/src/pay.ts b/src/pay.ts");
    expect(diffText).toContain("@@ -1,3 +1,4 @@");
    const parsed = parseReviewPatch(diffText);
    expect(parsed?.name).toBe("src/pay.ts");
    expect(parsed?.hunks[0]?.additionStart).toBe(1);
    expect(parsed?.hunks[0]?.additionCount).toBe(4);

    const quoted = gitDiffText({
      filename: "my file.ts",
      previousFilename: "old name.ts",
      status: "renamed",
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    });
    expect(quoted).toContain('diff --git "a/old name.ts" "b/my file.ts"');
    expect(quoted).toContain("rename from old name.ts");
    expect(parseReviewPatch(quoted)?.name).toBe("my file.ts");
  });

  it("renders the comment on the diff and escapes it", async () => {
    const review = detail([
      stored(
        sampleFinding({
          title: "<b>xss</b>",
          body: "Positive amounts <script> return success.",
          suggestion: "return gateway.capture(amount);",
        }),
      ),
    ]);
    const html = await renderDetailHtml(
      buildReviewDetail({
        review,
        files: [
          {
            filename: "src/pay.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: PATCH,
            previousFilename: null,
          },
        ],
        diffUnavailable: false,
        githubApiUrl: "https://api.github.com",
        now: Date.parse("2026-10-13T15:05:00.000Z"),
      }),
    );
    expect(html).toContain('href="/ui"');
    expect(html).toContain("https://github.com/acme/demo/pull/7");
    expect(html).toContain("src/pay.ts");
    expect(html).toContain("&lt;b&gt;xss&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<script[\s>]/);
    expect(html).not.toContain("<b>xss</b>");
    const text = html.replace(/<[^>]+>/g, "");
    const lineAt = text.indexOf("if (amount > 0) return { ok: true };");
    expect(lineAt).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Positive amounts")).toBeGreaterThan(lineAt);
    expect(html).toContain("1 finding");
    expect(html).toContain(">trigger<");
    expect(html).toContain('title="auto"');
    expect(html).toContain('datetime="2026-10-13T15:05:00.000Z"');
    expect(html).toContain(">P0<");
    expect(html).toContain("P0/P1");
  });

  it("shows status instead of zero counts, and one tag when kind and category match", async () => {
    const now = Date.parse("2026-10-13T16:00:00.000Z");
    const failed = detail([]);
    failed.outcome = "failed";
    failed.verdict = null;
    failed.p0 = 0;
    failed.p1 = 0;
    failed.p2 = 0;
    failed.p3 = 0;
    failed.findingCount = null;
    failed.checked = ["payment capture"];
    failed.error = "clone failed: permission denied";
    failed.finishedAt = "2026-10-13T15:10:00.000Z";
    const failedHtml = await renderDetailHtml(
      buildReviewDetail({
        review: failed,
        files: [],
        diffUnavailable: true,
        githubApiUrl: "https://api.github.com",
        now,
      }),
    );
    expect(failedHtml).toContain("clone failed: permission denied");
    expect(failedHtml).toContain("The diff could not be loaded from GitHub. Saved comments are still listed.");
    expect(failedHtml).not.toContain(">P0<");
    expect(failedHtml).not.toContain("payment capture");

    const running = detail([]);
    running.outcome = "running";
    running.verdict = null;
    running.finishedAt = null;
    running.p1 = 0;
    running.checked = ["payment capture"];
    running.startedAt = new Date(now - 5 * 60 * 1000).toISOString();
    const runningHtml = await renderDetailHtml(
      buildReviewDetail({
        review: running,
        files: [],
        diffUnavailable: false,
        githubApiUrl: "https://api.github.com",
        now,
      }),
    );
    expect(runningHtml).toContain("进行中");
    expect(runningHtml).not.toContain(">P0<");
    expect(runningHtml).not.toContain("5m");

    running.startedAt = new Date(now - STUCK_AFTER_MS).toISOString();
    const stuckHtml = await renderDetailHtml(
      buildReviewDetail({
        review: running,
        files: [],
        diffUnavailable: false,
        githubApiUrl: "https://api.github.com",
        now,
      }),
    );
    expect(stuckHtml).toContain("疑似卡住");
    expect(stuckHtml).not.toContain("30m");

    const same = stored(sampleFinding());
    same.kind = "correctness";
    same.category = "Correctness";
    const tagged = await renderDetailHtml(
      buildReviewDetail({
        review: detail([same]),
        files: [],
        diffUnavailable: false,
        githubApiUrl: "https://api.github.com",
        now,
      }),
    );
    expect(tagged).toContain(">correctness<");
    expect(tagged).not.toContain(">Correctness<");
    expect(tagged).toContain("truncate");
  });

  it("labels in-progress rows instead of a growing duration", () => {
    const now = Date.parse("2026-10-13T16:00:00.000Z");
    const startedAt = new Date(now - STUCK_AFTER_MS - 1000).toISOString();
    const review = {
      taskId: "run",
      owner: "acme",
      repo: "demo",
      number: 9,
      title: "Still going",
      trigger: "opened",
      startedAt,
      finishedAt: null,
      outcome: "running" as const,
      verdict: null,
      p0: 0,
      p1: 0,
      p2: 0,
      p3: 0,
      findingCount: null,
      countsKnown: true,
    };
    const kind = reviewResult(review);
    const model: ReviewListModel = {
      version: "0.1.0",
      uptime: "1s",
      provider: "faux",
      model: "faux-1",
      codex: { kind: "plain", text: "Codex not signed in" },
      githubApp: false,
      githubToken: true,
      reviews: [
        {
          taskId: review.taskId,
          href: "/ui/reviews/run",
          repoLabel: "acme/demo #9",
          title: review.title,
          triggerLabel: displayTrigger(review.trigger),
          resultKind: kind,
          resultText: resultLabel(kind),
          p0: "0",
          p1: "0",
          p2: "0",
          p3: "0",
          p0On: false,
          p1On: false,
          p2On: false,
          p3On: false,
          duration: runningLabel(startedAt, now),
          whenIso: startedAt,
          whenLabel: formatTime(startedAt),
        },
      ],
      repos: ["acme/demo"],
      total: 1,
      shown: 1,
      form: { repo: "", result: "", since: "", from: "", to: "", q: "" },
      filtered: false,
      empty: null,
    };
    const html = renderListHtml(model);
    expect(html).toContain("疑似卡住");
    expect(html).not.toContain("30m");
    expect(html).toContain("<time ");
  });
});

function stored(finding: ReturnType<typeof sampleFinding>, ordinal = 0): StoredComment {
  return {
    ordinal,
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    priority: finding.priority,
    kind: finding.kind,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    trigger: finding.trigger,
    suggestion: finding.suggestion,
    confidence: finding.confidence,
    fingerprint: finding.fingerprint,
    evidence: finding.evidence,
  };
}

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
    verdict: "block",
    p0: 0,
    p1: 1,
    p2: 0,
    p3: 0,
    findingCount: comments.length,
    countsKnown: true,
    sha: "a".repeat(40),
    baseSha: "b".repeat(40),
    baseRef: "main",
    installationId: 99,
    verdictReason: "Do not merge.",
    overallConfidence: 0.8,
    checked: ["payment capture"],
    provider: "faux",
    model: "faux-1",
    policy: {
      profile: "default",
      trigger: "auto",
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
