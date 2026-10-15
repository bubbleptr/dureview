import { describe, expect, it } from "vitest";
import {
  commentAnchorIndexes,
  findingLineCss,
  focusSegments,
  gapKey,
  orderCommentedFirst,
  windowDiffText,
} from "../src/ui/diff-focus.js";
import type { DetailLineView } from "../src/ui/detail-model.js";
import { gitDiffText } from "../src/ui/diff.js";
import { parseReviewPatch } from "../src/ui/review-presentation.js";

function line(kind: DetailLineView["kind"], text: string, newLabel = "", oldLabel = ""): DetailLineView {
  return {
    kind,
    oldLabel,
    newLabel,
    mark: kind === "add" ? "+" : kind === "del" ? "−" : " ",
    text,
    severity: null,
    comments: [],
  };
}

describe("diff focus", () => {
  it("keeps ten lines of context around a comment and hides the rest", () => {
    const lines = [line("hunk", "@@ -1,80 +1,80 @@")];
    for (let number = 1; number <= 80; number += 1) lines.push(line("context", `line ${number}`, String(number), String(number)));
    const anchor = 41;
    lines[anchor] = { ...lines[anchor]!, severity: 1, comments: [comment()] };
    const segments = focusSegments(lines, commentAnchorIndexes(lines), new Set());
    expect(segments.map((segment) => segment.kind)).toEqual(["hidden", "shown", "hidden"]);
    const shown = segments[1];
    expect(shown).toMatchObject({ kind: "shown", collapsible: false });
    if (shown?.kind !== "shown") return;
    expect(shown.start).toBe(anchor - 10);
    expect(shown.end).toBe(anchor + 10);
    expect(segments[0]).toMatchObject({ kind: "hidden", lines: 30 });
    expect(segments[2]).toMatchObject({ kind: "hidden", lines: 29 });
  });

  it("lets an expanded gap collapse back to the same hidden span", () => {
    const lines = Array.from({ length: 30 }, (_, index) => line("context", `l${index}`, String(index + 1), String(index + 1)));
    lines[15] = { ...lines[15]!, severity: 0 };
    const hidden = focusSegments(lines, [15], new Set()).find((segment) => segment.kind === "hidden");
    expect(hidden?.kind).toBe("hidden");
    if (hidden?.kind !== "hidden") return;
    const opened = focusSegments(lines, [15], new Set([gapKey(hidden.start, hidden.end)]));
    expect(opened.some((segment) => segment.kind === "shown" && segment.collapsible && segment.start === hidden.start)).toBe(true);
    const closed = focusSegments(lines, [15], new Set());
    expect(closed.some((segment) => segment.kind === "hidden" && segment.start === hidden.start && segment.end === hidden.end)).toBe(true);
  });

  it("shows a file with no comments as one span", () => {
    const lines = [line("context", "a", "1", "1"), line("context", "b", "2", "2")];
    expect(focusSegments(lines, [], new Set())).toEqual([{ kind: "shown", start: 0, end: 1, collapsible: false }]);
  });

  it("sorts commented files ahead of the others", () => {
    expect(orderCommentedFirst(["b", "a", "c"], (item) => (item === "c" ? 2 : 0))).toEqual(["c", "b", "a"]);
  });

  it("builds a parseable window and boxes the comment's line range", () => {
    const lines = [line("context", "before", "1", "1"), line("add", "changed", "2"), line("context", "after", "3", "2")];
    const patch = windowDiffText({ filename: "src/pay.ts", status: "modified" }, lines);
    expect(patch).toContain("@@ -1,2 +1,3 @@");
    const parsed = parseReviewPatch(patch ?? "");
    expect(parsed?.name).toBe("src/pay.ts");
    const later = parseReviewPatch(
      gitDiffText({
        filename: "src/pay.ts",
        previousFilename: null,
        status: "modified",
        patch: "@@ -40,2 +40,2 @@\n context\n+changed",
      }) ?? "",
    );
    expect(later?.hunks[0]?.additionStart).toBe(40);
    expect(later?.hunks[0]?.collapsedBefore).toBe(0);
    expect(later?.hunks[0]?.unifiedLineStart).toBe(0);
    const css = findingLineCss([{ start: 2, end: 2, priority: 0 }]);
    expect(css).toContain('[data-line="2"]');
    expect(css).toContain("--finding-accent:oklch(0.62 0.17 48)");
    expect(css).toContain(":host([data-theme=dark])");
    expect(css).not.toContain(":host-context(");
  });
});

function comment() {
  return {
    ordinal: 1,
    anchor: "c-1",
    priority: 1,
    tags: [],
    confidence: "90%",
    title: "Bug",
    body: "Body",
    trigger: "when",
    evidence: [],
    suggestion: null,
    path: "src/pay.ts",
    startLine: 41,
    endLine: 41,
  };
}
