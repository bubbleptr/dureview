import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mobileSidebarConcealed } from "../src/ui/sidebar-state.js";

function mobileCss(): string {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const start = css.indexOf("@media (max-width: 767px)");
  const rest = css.slice(start);
  const next = rest.indexOf("@media", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("mobile sidebar", () => {
  const css = mobileCss();

  it("keeps the sheet full width when the desktop sidebar is collapsed", () => {
    expect(css).toMatch(/html\[data-sidebar="collapsed"\] \.app-sidebar\s*\{[^}]*width:\s*16rem/);
    expect(css).toMatch(/html\[data-sidebar="collapsed"\] \.brand-mark\s*\{[^}]*display:\s*none/);
  });

  it("hides a closed sheet from hit testing and the accessibility tree", () => {
    expect(css).toMatch(/\.app-sidebar\s*\{[^}]*visibility:\s*hidden/);
    expect(css).toMatch(/html\[data-mobile-nav="open"\] \.app-sidebar\s*\{[^}]*visibility:\s*visible/);
    expect(mobileSidebarConcealed(true, undefined)).toBe(true);
    expect(mobileSidebarConcealed(true, "open")).toBe(false);
    expect(mobileSidebarConcealed(false, undefined)).toBe(false);
  });
});