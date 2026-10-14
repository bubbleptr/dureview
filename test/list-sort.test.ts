import { describe, expect, it } from "vitest";
import type { ReviewRowView } from "../src/ui/list-model.js";
import { compareReviewRows } from "../src/ui/list-sort.js";

function row(duration: string, durationMs: number | null): ReviewRowView {
  return {
    taskId: duration,
    href: "/ui/reviews/x",
    repoLabel: "acme/demo #1",
    title: duration,
    triggerLabel: "auto",
    resultKind: durationMs === null ? "running" : "pass",
    resultText: durationMs === null ? "Running" : "Pass",
    p0: "0",
    p1: "0",
    p2: "0",
    p3: "0",
    p0On: false,
    p1On: false,
    p2On: false,
    p3On: false,
    duration,
    durationMs,
    whenIso: "2026-10-13T00:00:00.000Z",
    whenLabel: "2026-10-13 00:00 UTC",
    modelLine: null,
  };
}

describe("duration sort", () => {
  const rows = [
    row("59s", 59_000),
    row("1m", 60_000),
    row("9m", 9 * 60_000),
    row("10m", 10 * 60_000),
    row("进行中", null),
    row("—", null),
  ];

  it("orders by milliseconds, with running and unknown last", () => {
    const desc = [...rows].sort((left, right) => compareReviewRows(left, right, "duration", "desc"));
    expect(desc.map((item) => item.duration)).toEqual(["10m", "9m", "1m", "59s", "进行中", "—"]);
    const asc = [...rows].sort((left, right) => compareReviewRows(left, right, "duration", "asc"));
    expect(asc.map((item) => item.duration)).toEqual(["59s", "1m", "9m", "10m", "进行中", "—"]);
  });
});
