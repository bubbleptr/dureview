import { describe, expect, it } from "vitest";
import { trendLineAnimationActive } from "../src/components/stats-charts.js";

describe("token trend motion", () => {
  it("draws the full line immediately, including when reduced motion is requested", () => {
    expect(trendLineAnimationActive(false)).toBe(false);
    expect(trendLineAnimationActive(true)).toBe(false);
  });
});