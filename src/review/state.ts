import { defineDoc } from "@earendil-works/pi-durable";
import type { Finding, Verdict } from "./schema.js";

/** Findings the model committed. Replay of submit_review overwrites this with the same payload. */
export const ReviewDraft = defineDoc<{
  submitted: boolean;
  verdict: Verdict;
  verdictReason: string;
  overallConfidence: number | null;
  checked: string[];
  findings: Finding[];
}>({
  kind: "dureview.draft",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    submitted: false,
    verdict: "clean",
    verdictReason: "",
    overallConfidence: null,
    checked: [],
    findings: [],
  }),
});

/**
 * Head SHAs that already have a review task, plus the one automatic review claimed for a
 * `trigger: once` pull request. Session-scoped so enqueue is atomic with task creation.
 * Version 2 adds `onceByPull`. Existing indexes migrate in place.
 */
export const ReviewIndex = defineDoc<{
  byKey: Record<string, number>;
  onceByPull: Record<string, number>;
}>({
  kind: "dureview.index",
  version: 2,
  scope: "session",
  migrate: (value) => ({
    byKey: numberMap(value.byKey),
    onceByPull: numberMap(value.onceByPull),
  }),
  initial: () => ({ byKey: {}, onceByPull: {} }),
});

function numberMap(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number") result[key] = item;
  }
  return result;
}
