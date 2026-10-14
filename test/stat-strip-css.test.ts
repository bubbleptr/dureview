import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function statStripCss(): string {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const start = css.indexOf(".stat-strip {");
  const end = css.indexOf(".app-sidebar {");
  return css.slice(start, end);
}

describe("stat strip borders", () => {
  const css = statStripCss();

  it("draws one outer border and 1px gaps instead of per-cell borders", () => {
    expect(css).toMatch(/\.stat-strip\s*\{[^}]*gap:\s*1px/);
    expect(css).toMatch(/\.stat-strip\s*\{[^}]*border:\s*1px solid var\(--border\)/);
    expect(css).toMatch(/\.stat-strip\s*\{[^}]*background:\s*var\(--border\)/);
    expect(css).toMatch(/\.stat-strip > \*\s*\{[^}]*border:\s*0/);
    expect(css).toMatch(/\.stat-strip > \*\s*\{[^}]*background:\s*var\(--background\)/);
    expect(css).not.toMatch(/border-left|border-top|border-block|nth-child/);
  });

  it("keeps the column counts at each breakpoint", () => {
    expect(css).toMatch(/\.stat-strip\s*\{[^}]*grid-template-columns:\s*repeat\(2,/);
    expect(css).toMatch(/@media \(min-width: 1024px\)[\s\S]*\.stat-strip:not\(\.stat-strip-6\)\s*\{[^}]*repeat\(4,/);
    expect(css).toMatch(/@media \(min-width: 1100px\)[\s\S]*\.stat-strip-6\s*\{[^}]*repeat\(3,/);
  });
});