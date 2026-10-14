import type { ReviewRowView } from "./list-model.js";

export function compareReviewRows(
  left: ReviewRowView,
  right: ReviewRowView,
  sort: string,
  dir: "asc" | "desc",
): number {
  if (sort === "duration") return compareDuration(left.durationMs, right.durationMs, dir);
  const factor = dir === "asc" ? 1 : -1;
  const a = sortValue(left, sort);
  const b = sortValue(right, sort);
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a).localeCompare(String(b)) * factor;
}

/** Measured durations sort by milliseconds. Running and unknown rows stay last in both directions. */
export function compareDuration(left: number | null, right: number | null, dir: "asc" | "desc"): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const factor = dir === "asc" ? 1 : -1;
  return (left - right) * factor;
}

function sortValue(row: ReviewRowView, sort: string): string | number {
  if (sort === "repo") return row.repoLabel;
  if (sort === "title") return row.title;
  if (sort === "trigger") return row.triggerLabel;
  if (sort === "result") return row.resultText;
  if (sort === "p0" || sort === "p1" || sort === "p2" || sort === "p3") return numericSort(row[sort]);
  if (sort === "when") return row.whenIso;
  return row.duration;
}

function numericSort(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}
