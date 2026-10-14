import { describe, expect, it } from "vitest";
import { MIN_DIFF_WIDTH, PANEL_HANDLE_WIDTH, fitPanelWidths } from "../src/ui/panel-widths.js";

describe("panel widths", () => {
  it("keeps the preferred widths until the container is known", () => {
    expect(fitPanelWidths(240, 320, null)).toEqual({ tree: 240, summary: 320 });
  });

  it("leaves a 320px diff when saved maximums exceed a 1024px layout", () => {
    const container = 1024 - 248;
    const fitted = fitPanelWidths(420, 520, container);
    const diff = container - PANEL_HANDLE_WIDTH * 2 - fitted.tree - fitted.summary;
    expect(diff).toBeGreaterThanOrEqual(MIN_DIFF_WIDTH);
    expect(fitted.tree).toBeGreaterThan(0);
    expect(fitted.summary).toBeGreaterThan(0);
  });

  it("keeps defaults on a wide detail column", () => {
    expect(fitPanelWidths(240, 320, 1200)).toEqual({ tree: 240, summary: 320 });
  });
});
