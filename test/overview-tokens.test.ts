import { describe, expect, it } from "vitest";
import { omittedUsageNote, overviewTokenStat, tokenTrendMessage } from "../src/ui/overview-tokens.js";

describe("overview token usage", () => {
  it("keeps unrecorded usage unknown", () => {
    expect(overviewTokenStat(null)).toEqual({ value: "—", detail: "Not recorded on this page" });
    expect(overviewTokenStat({ total: null, knownReviews: 0, unknownReviews: 0 })).toEqual({
      value: "—",
      detail: "No reviews",
    });
    expect(overviewTokenStat({ total: null, knownReviews: 0, unknownReviews: 1 })).toEqual({
      value: "—",
      detail: "Unknown for 1 review",
    });
    expect(overviewTokenStat({ total: null, knownReviews: 0, unknownReviews: 4 }).value).toBe("—");
    expect(overviewTokenStat({ total: null, knownReviews: 0, unknownReviews: 4 }).detail).toBe("Unknown for 4 reviews");
  });

  it("shows a measured zero and discloses omitted reviews", () => {
    expect(overviewTokenStat({ total: 0, knownReviews: 2, unknownReviews: 0 })).toEqual({
      value: "0",
      detail: "Last 7 days",
    });
    expect(overviewTokenStat({ total: 1500, knownReviews: 2, unknownReviews: 3 })).toEqual({
      value: "1.5k",
      detail: "Last 7 days · 3 without usage",
    });
    expect(omittedUsageNote({ total: 1500, knownReviews: 2, unknownReviews: 3 })).toBe(
      "3 reviews have no usage and are omitted from the trend.",
    );
    expect(omittedUsageNote({ total: null, knownReviews: 0, unknownReviews: 3 })).toBeNull();
  });

  it("does not describe missing measurements as an empty trend", () => {
    const usage = { total: null, knownReviews: 0, unknownReviews: 2 };
    const message = tokenTrendMessage(usage, false);
    expect(message).toContain("unknown");
    expect(message).not.toBe("No token usage in the last 7 days.");
    expect(tokenTrendMessage(null, false)).toBe("No token usage in the last 7 days.");
    expect(tokenTrendMessage({ total: 10, knownReviews: 1, unknownReviews: 0 }, true)).toBeNull();
  });
});
