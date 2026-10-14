import type { ReviewResultKind } from "../review/archive.js";
import type { ReviewFormState } from "./query.js";

export type CodexView =
  | { kind: "plain"; text: string }
  | { kind: "timed"; lead: string; iso: string; label: string };

export type ReviewRowView = {
  taskId: string;
  href: string;
  repoLabel: string;
  title: string;
  triggerLabel: string;
  resultKind: ReviewResultKind;
  resultText: string;
  p0: string;
  p1: string;
  p2: string;
  p3: string;
  p0On: boolean;
  p1On: boolean;
  p2On: boolean;
  p3On: boolean;
  duration: string;
  /** Elapsed milliseconds. Null while running or when the timestamps cannot be measured. */
  durationMs: number | null;
  whenIso: string;
  whenLabel: string;
  /** `provider/model · thinking` for the run, when the archive recorded it. */
  modelLine: string | null;
};

/** Serializable list payload. No diff text, tokens, or filesystem paths. */
export type ReviewListModel = {
  version: string;
  uptime: string;
  provider: string;
  model: string;
  thinking: string;
  codex: CodexView;
  githubApp: boolean;
  githubToken: boolean;
  reviews: ReviewRowView[];
  repos: string[];
  total: number;
  shown: number;
  form: ReviewFormState;
  filtered: boolean;
  empty: "none" | "filtered" | null;
};
