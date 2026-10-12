import { describe, expect, it } from "vitest";
import { commentableLines } from "../src/review/diff.js";
import { FIXTURE_DIFF } from "./support.js";

describe("diff lines", () => {
  it("records new-file lines from a hunk and skips deletions", () => {
    const lines = commentableLines(FIXTURE_DIFF);
    const file = lines.get("src/pay.ts");
    expect(file?.has(2)).toBe(true);
    expect(file?.has(3)).toBe(true);
    expect(file?.has(99)).toBe(false);
  });
});
