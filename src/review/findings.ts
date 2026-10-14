import { classifyFindings, type ClassifiedReview, type ReviewPolicy } from "./policy.js";
import type { Finding } from "./schema.js";

/** Why a finding was not posted as a new inline comment. Null when it was. */
export const SKIP_REASONS = [
  "low_confidence",
  "ignored",
  "out_of_range",
  "investigate",
  "empty_trigger",
  "priority",
  "p2_confidence",
  "overflow",
  "already_inlined",
  "publish_failed",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export type FindingPosting = {
  fingerprint: string;
  /** True when the finding was written to GitHub (inline comment, or the summary when summaries are on). */
  posted: boolean;
  /** Set when it was not a new inline comment, including when a summary still mentioned it. */
  skipReason: SkipReason | null;
};

/** One finding to persist, including ones that were not posted. */
export type RecordedFinding = {
  finding: Finding;
  /** Null when the caller did not classify posting. */
  posted: boolean | null;
  skipReason: SkipReason | null;
};

/** Null prototype so `constructor` and other Object.prototype names are not languages. */
const LANGUAGES: Record<string, string> = Object.assign(Object.create(null), {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  h: "c",
  c: "c",
  m: "objective-c",
  mm: "objective-cpp",
  swift: "swift",
  scala: "scala",
  sc: "scala",
  md: "markdown",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  toml: "toml",
  vue: "vue",
  svelte: "svelte",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  lua: "lua",
  zig: "zig",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  ml: "ocaml",
  r: "r",
  dart: "dart",
  proto: "protobuf",
});

const SKIP = new Set<string>(SKIP_REASONS);

export function fileFacts(path: string): { extension: string | null; language: string | null } {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { extension: null, language: null };
  const extension = base.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]+$/.test(extension) || extension.length > 16) return { extension: null, language: null };
  if (!Object.hasOwn(LANGUAGES, extension)) return { extension, language: null };
  const language = LANGUAGES[extension];
  return { extension, language: typeof language === "string" ? language : null };
}

/**
 * Eligibility is not a GitHub write. Use this when publish failed before any write,
 * so a finding the classifier would have posted is stored as not posted.
 */
export function postingsWhenPublishFailed(postings: readonly FindingPosting[]): FindingPosting[] {
  return postings.map((posting) =>
    posting.posted ? { fingerprint: posting.fingerprint, posted: false, skipReason: "publish_failed" } : posting,
  );
}

export function isSkipReason(value: string | null | undefined): value is SkipReason {
  return typeof value === "string" && SKIP.has(value);
}

/**
 * Posting decision for every deduped finding classifyFindings kept.
 * `posted` is true for a new inline comment, and for a summary mention when `summary` is on.
 * `skipReason` explains why it was not a new inline comment.
 */
export function postingsFromClassified(classified: ClassifiedReview, policy: ReviewPolicy): FindingPosting[] {
  const inline = new Set(classified.inline.map((item) => item.finding.fingerprint));
  const overflow = new Set(classified.overflow.map((finding) => finding.fingerprint));
  const postings: FindingPosting[] = [];
  for (const item of classified.dropped) {
    postings.push({
      fingerprint: item.finding.fingerprint,
      posted: false,
      skipReason: item.reason === "confidence" ? "low_confidence" : "ignored",
    });
  }
  for (const finding of classified.outOfRange) {
    postings.push({
      fingerprint: finding.fingerprint,
      posted: policy.summary,
      skipReason: "out_of_range",
    });
  }
  for (const finding of classified.folded) {
    postings.push({
      fingerprint: finding.fingerprint,
      posted: policy.summary,
      skipReason: foldSkipReason(finding, policy),
    });
  }
  for (const finding of classified.table) {
    if (inline.has(finding.fingerprint)) {
      postings.push({ fingerprint: finding.fingerprint, posted: true, skipReason: null });
      continue;
    }
    if (overflow.has(finding.fingerprint)) {
      postings.push({ fingerprint: finding.fingerprint, posted: policy.summary, skipReason: "overflow" });
      continue;
    }
    postings.push({
      fingerprint: finding.fingerprint,
      posted: policy.summary,
      skipReason: "already_inlined",
    });
  }
  return postings;
}

export function postingsForReview(input: {
  findings: Finding[];
  diff: string;
  policy: ReviewPolicy;
  alreadyInlined?: ReadonlySet<string>;
}): FindingPosting[] {
  return postingsFromClassified(
    classifyFindings({
      findings: input.findings,
      diff: input.diff,
      policy: input.policy,
      alreadyInlined: input.alreadyInlined,
    }),
    input.policy,
  );
}

/** Attach posting decisions. Higher-confidence duplicates collapse, matching classification. */
export function recordedFindings(findings: Finding[], postings: readonly FindingPosting[]): RecordedFinding[] {
  const byFingerprint = new Map(postings.map((posting) => [posting.fingerprint, posting]));
  const rows: RecordedFinding[] = [];
  for (const finding of dedupe(findings)) {
    const posting = byFingerprint.get(finding.fingerprint);
    rows.push({
      finding,
      posted: posting ? posting.posted : null,
      skipReason: posting?.skipReason ?? null,
    });
  }
  return rows;
}

function foldSkipReason(finding: Finding, policy: ReviewPolicy): SkipReason {
  if (finding.kind === "investigate") return "investigate";
  if (finding.trigger.trim().length === 0) return "empty_trigger";
  if (finding.priority > policy.minInlinePriority) return "priority";
  if (finding.priority === 2 && finding.confidence < policy.p2InlineMinConfidence) return "p2_confidence";
  return "priority";
}

function dedupe(findings: Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (!existing || finding.confidence > existing.confidence) byFingerprint.set(finding.fingerprint, finding);
  }
  return [...byFingerprint.values()];
}
