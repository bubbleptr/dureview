import { describe, expect, it } from "vitest";
import { seriesColor } from "../src/ui/chart-palette.js";

describe("chart series colors", () => {
  it("maps severity, finding type, and verdict to stable tokens", () => {
    expect(seriesColor("P0")).toBe("var(--chart-1)");
    expect(seriesColor("Bug")).toBe("var(--chart-1)");
    expect(seriesColor("Block")).toBe("var(--chart-1)");
    expect(seriesColor("P1")).toBe("var(--chart-2)");
    expect(seriesColor("Flag")).toBe("var(--chart-2)");
    expect(seriesColor("Fix recommended")).toBe("var(--chart-2)");
    expect(seriesColor("P2")).toBe("var(--chart-3)");
    expect(seriesColor("Security")).toBe("var(--chart-3)");
    expect(seriesColor("security")).toBe("var(--chart-3)");
    expect(seriesColor("P3")).toBe("var(--chart-4)");
    expect(seriesColor("Unknown")).toBe("var(--chart-4)");
    expect(seriesColor("Clean")).toBe("var(--chart-5)");
  });

  it("keeps an unnamed series on the same token", () => {
    const first = seriesColor("gpt-5.5");
    expect(first).toBe(seriesColor("gpt-5.5"));
    expect(first).toMatch(/^var\(--chart-[1-5]\)$/);
    expect(seriesColor("timeout")).toBe(seriesColor("timeout"));
  });
});
