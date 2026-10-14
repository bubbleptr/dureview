import { describe, expect, it } from "vitest";
import { homeStatsSearches } from "../src/ui/home-query.js";
import { timezoneOffsetMinutes } from "../src/ui/stats-query.js";

describe("overview stats query", () => {
  it("passes the browser timezone and repo into both windows", () => {
    expect(homeStatsSearches("?tz=480&repo=acme/demo")).toEqual({
      week: "range=7d&repo=acme%2Fdemo&tz=480",
      day: "range=24h&repo=acme%2Fdemo&tz=480",
    });
  });

  it("defaults a missing timezone to UTC and drops an unsafe repo", () => {
    expect(homeStatsSearches("?repo=../etc")).toEqual({
      week: "range=7d&tz=0",
      day: "range=24h&tz=0",
    });
  });

  it("clamps an out-of-range timezone", () => {
    expect(timezoneOffsetMinutes("99999")).toBe(840);
    expect(homeStatsSearches("?tz=99999").week).toBe("range=7d&tz=840");
    expect(timezoneOffsetMinutes("-99999")).toBe(-840);
  });
});
