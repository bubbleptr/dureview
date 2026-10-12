import { defineDoc } from "@earendil-works/pi-durable";
import type { Finding } from "../types.js";

/** Findings the model committed. Replay of submit_review overwrites this with the same payload. */
export const ReviewDraft = defineDoc<{
  submitted: boolean;
  summary: string;
  findings: Finding[];
}>({
  kind: "dureview.draft",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ submitted: false, summary: "", findings: [] }),
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
