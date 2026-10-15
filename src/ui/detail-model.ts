import type { ReviewResultKind } from "../review/archive.js";

export type DetailCommentView = {
  ordinal: number;
  anchor: string;
  priority: number;
  /** Null when the comment was stored before finding types existed. */
  typeLabel: string | null;
  tags: string[];
  confidence: string;
  title: string;
  body: string;
  trigger: string;
  evidence: string[];
  suggestion: string | null;
  path: string;
  startLine: number;
  endLine: number;
};

export type DetailLineView = {
  kind: "hunk" | "add" | "del" | "context";
  oldLabel: string;
  newLabel: string;
  mark: string;
  text: string;
  severity: number | null;
  comments: DetailCommentView[];
};

export type DetailFileView = {
  anchor: string;
  filename: string;
  status: string;
  statusMark: string;
  stats: string | null;
  patchMissing: boolean;
  patchTruncated: boolean;
  /** One-file git diff, or null when GitHub omitted the patch. */
  diffText: string | null;
  lines: DetailLineView[];
  unanchored: DetailCommentView[];
};

export type DetailFindingLink = {
  anchor: string;
  priority: number;
  typeLabel: string | null;
  title: string;
  where: string;
};

export type DetailCount = {
  label: "P0" | "P1" | "P2" | "P3";
  value: string;
  on: boolean;
};

export type DetailSummary =
  | {
      mode: "incomplete";
      resultKind: ReviewResultKind;
      resultText: string;
      note: string;
    }
  | {
      mode: "complete";
      resultKind: ReviewResultKind;
      resultText: string;
      verdictLabel: string | null;
      verdictKind: "pass" | "suggest" | "blocker" | null;
      reason: string | null;
      counts: DetailCount[];
      findings: DetailFindingLink[];
      checked: string[];
      noComments: boolean;
    };

export type DetailSettings =
  | { recorded: false }
  | { recorded: true; rows: Array<{ key: string; value: string }> };

/**
 * Fields the shell can render before the file list arrives.
 * Full SHAs, tokens, and filesystem paths are not included.
 */
export type ReviewDetailHeader = {
  pageTitle: string;
  backHref: "/ui/reviews";
  pullHref: string | null;
  pullLabel: string;
  heading: string;
  resultKind: ReviewResultKind;
  resultText: string;
  triggerLabel: string;
  duration: string;
  whenIso: string;
  whenLabel: string;
};

/**
 * Serializable detail page. Diff lines are included. Full SHAs, tokens, and
 * filesystem paths are not.
 */
export type ReviewDetailModel = ReviewDetailHeader & {
  diffUnavailable: boolean;
  hiddenFiles: number;
  noChangedFiles: boolean;
  outsideTitle: string;
  files: DetailFileView[];
  outside: DetailCommentView[];
  summary: DetailSummary;
  settings: DetailSettings;
};
