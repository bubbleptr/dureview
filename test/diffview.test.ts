import { describe, expect, it } from "vitest";
import { parsePatch, placeReview } from "../src/ui/diff.js";
import { renderReviewDetail } from "../src/ui/page.js";
import type { ReviewDetail } from "../src/review/archive.js";
import { sampleFinding } from "./support.js";
import type { StoredComment } from "../src/review/archive.js";

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

  it("renders the comment on the diff and escapes it", () => {
    const review = detail([
      stored(
        sampleFinding({
          title: "<b>xss</b>",
          body: "Positive amounts <script> return success.",
          suggestion: "return gateway.capture(amount);",
        }),
      ),
    ]);
    const html = renderReviewDetail({
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
    });
    expect(html).toContain("href=\"/ui\"");
    expect(html).toContain("https://github.com/acme/demo/pull/7");
    expect(html).toContain("src/pay.ts");
    expect(html).toContain("&lt;b&gt;xss&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>xss</b>");
    expect(html.indexOf("Positive amounts")).toBeGreaterThan(html.indexOf("if (amount &gt; 0)"));
    expect(html).toContain("<dt>trigger</dt><dd>auto</dd>");
    expect(html).toContain("class=\"badge blocker\"");
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
  };
}
