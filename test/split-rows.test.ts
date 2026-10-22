import { describe, expect, it } from "vitest";
import type { DetailLineView } from "../src/ui/detail-model.js";
import { gitDiffText, parsePatch } from "../src/ui/diff.js";
import { parseReviewPatch } from "../src/ui/review-presentation.js";
import { splitCodeRows } from "../src/ui/split-rows.js";
import type { FileDiffMetadata } from "@pierre/diffs";

describe("split code rows", () => {
  it("pairs each change block the way Pierre does", () => {
    const patches = [
      ["@@ -1,3 +1,3 @@", " same", "-old", "+new", " tail"].join("\n"),
      ["@@ -4,4 +4,6 @@", " keep", "-alpha", "-beta", "+prelude", "+alpha", "+beta", "+extra", " end"].join("\n"),
      ["@@ -1,4 +1,2 @@", "-one", "-two", "-three", "+three", " stay"].join("\n"),
      ["@@ -1,1 +1,2 @@", "-only old", "+only new", "+and another"].join("\n"),
      ["@@ -8,3 +8,3 @@", " ctx", "-left", "+right", " ctx"].join("\n"),
    ];
    for (const patch of patches) {
      expect(texts(splitCodeRows(linesFrom(patch)))).toEqual(pierreTexts(patch));
    }
  });

  it("puts the unmatched lines on the side Pierre leaves blank", () => {
    const patch = ["@@ -1,3 +1,4 @@", "-    return foo(input);", "-    return foo(other);", "+    return bar();", "+    return foo(input);", "+    return foo(other);", " stay"].join("\n");
    const rows = texts(splitCodeRows(linesFrom(patch)));
    expect(rows).toEqual(pierreTexts(patch));
    expect(rows.some((row) => row[0] === null && row[1] !== null)).toBe(true);
  });
});

function linesFrom(patch: string): DetailLineView[] {
  return parsePatch(patch).map((line) => ({
    kind: line.kind,
    oldLabel: line.oldLine === null ? "" : String(line.oldLine),
    newLabel: line.newLine === null ? "" : String(line.newLine),
    mark: "",
    text: line.text,
    severity: null,
    comments: [],
  }));
}

function texts(rows: ReturnType<typeof splitCodeRows>): Array<[string | null, string | null]> {
  return rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null]);
}

function pierreTexts(patch: string): Array<[string | null, string | null]> {
  const diff = gitDiffText({ filename: "src/pay.ts", previousFilename: null, status: "modified", patch });
  const file = parseReviewPatch(diff);
  if (!file) throw new Error("patch did not parse");
  return pierreRows(file);
}

function pierreRows(file: FileDiffMetadata): Array<[string | null, string | null]> {
  const rows: Array<[string | null, string | null]> = [];
  for (const hunk of file.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index += 1) {
          const text = clean(file.additionLines[content.additionLineIndex + index]);
          rows.push([text, text]);
        }
        continue;
      }
      const count = Math.max(content.deletions, content.additions);
      for (let index = 0; index < count; index += 1) {
        rows.push([
          index < content.deletions ? clean(file.deletionLines[content.deletionLineIndex + index]) : null,
          index < content.additions ? clean(file.additionLines[content.additionLineIndex + index]) : null,
        ]);
      }
    }
  }
  return rows;
}

function clean(value: string | undefined): string {
  return (value ?? "").replace(/\n$/, "");
}
