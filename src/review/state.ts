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

/** Head SHAs that already have a review task. Session-scoped so enqueue is atomic with task creation. */
export const ReviewIndex = defineDoc<{
  byKey: Record<string, number>;
}>({
  kind: "dureview.index",
  version: 1,
  scope: "session",
  initial: () => ({ byKey: {} }),
});
