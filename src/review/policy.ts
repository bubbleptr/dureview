import { commentableLines } from "./diff.js";
import { isInformational, type Finding, type Priority } from "./schema.js";

/**
 * `.dureview.md` or the configured model is something the operator has to fix.
 * The review check uses this type for `action_required` instead of matching error text.
 */
export class ReviewConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewConfigError";
  }
}

export type ReviewProfile = "quiet" | "default" | "loud";

/** When a pull request event starts a review. `/dureview` bypasses this. */
export type ReviewTrigger = "auto" | "once" | "manual";

/** Language for model prose and for dureview's own labels, verdicts, and fixed notes. */
export type ReviewLanguage = "en" | "zh";

/**
 * Thresholds applied after the model returns. Defaults match the review format:
 * drop confidence below 0.5, inline at most 10 comments, P2 inlines only at 0.7.
 * Summary comments are off. Finding titles and template strings are English.
 * Drafts are skipped. Pull request events start a review only when `trigger` is
 * `auto` or `once`. The built-in trigger is `manual` (`/dureview` only).
 * A repository `.dureview.md` front matter block can override any field.
 * That file is read from the pull request's base branch.
 * An omitted `trigger` uses the server default (`DUREVIEW_DEFAULT_TRIGGER`, `manual`).
 */
export type ReviewPolicy = {
  profile: ReviewProfile;
  /**
   * `auto` reviews opened, reopened, synchronize, and ready_for_review.
   * `once` reviews the first of those that is allowed (opened, or ready_for_review
   * when the pull request started as a draft). `manual` reviews only on `/dureview`.
   * When the file omits this key, the value is the server default (`manual`).
   */
  trigger: ReviewTrigger;
  /** When false, draft pull requests are skipped until ready_for_review. */
  drafts: boolean;
  /** Findings below this confidence are discarded. */
  minConfidence: number;
  /**
   * Highest priority number that may be posted inline.
   * 0 inlines P0 only, 1 inlines P0–P1, 2 inlines P0–P2, 3 also allows P3.
   * `investigate` is never inlined.
   */
  minInlinePriority: Priority;
  /** P2 findings inline only when confidence is at least this value. */
  p2InlineMinConfidence: number;
  /** Maximum new inline comments posted for one run. */
  maxInline: number;
  /** When true, DEFAULT_IGNORE is applied in addition to `ignore`. */
  ignoreDefaults: boolean;
  /** Extra path globs. With `ignore_defaults: false`, this list replaces the built-in one. */
  ignore: string[];
  /** Model titles/bodies and dureview template strings. Default English. */
  language: ReviewLanguage;
  /**
   * When true, post and update one summary comment (the previous behavior).
   * When false (default), post one inline comment per finding and nothing else.
   */
  summary: boolean;
  /**
   * When true, informational flags may be posted. They still never request changes.
   * When false (default), they are stored and left off GitHub.
   */
  postInformational: boolean;
};

export const DEFAULT_IGNORE = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/npm-shrinkwrap.json",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/poetry.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/Pipfile.lock",
  "**/packages.lock.json",
  "**/gradle.lockfile",
  "**/pubspec.lock",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.generated.*",
  "**/*_generated.*",
  "**/*.pb.go",
  "**/*.pb.ts",
  "**/*_pb2.py",
  "**/*.d.ts.map",
  "**/*.js.map",
  "**/*.css.map",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.webp",
  "**/*.ico",
  "**/*.pdf",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.eot",
  "**/*.zip",
  "**/*.gz",
  "**/*.tgz",
  "**/*.tar",
  "**/*.wasm",
  "**/*.class",
  "**/*.o",
  "**/*.so",
  "**/*.dll",
  "**/*.exe",
  "**/*.pyc",
  "**/*.bin",
] as const;

const PROFILE_PRESETS: Record<ReviewProfile, Pick<ReviewPolicy, "minInlinePriority" | "p2InlineMinConfidence">> = {
  quiet: { minInlinePriority: 1, p2InlineMinConfidence: 0.7 },
  default: { minInlinePriority: 2, p2InlineMinConfidence: 0.7 },
  loud: { minInlinePriority: 2, p2InlineMinConfidence: 0.5 },
};

/** Fallback when `.dureview.md` is missing or does not set `trigger`. */
export const BUILTIN_DEFAULT_TRIGGER: ReviewTrigger = "manual";

/** Server or caller override for fields the file leaves unset. */
export type PolicyDefaults = {
  /** Trigger used when `.dureview.md` is missing or does not set `trigger`. */
  trigger?: ReviewTrigger;
};

export function defaultPolicy(defaults: PolicyDefaults = {}): ReviewPolicy {
  return {
    profile: "default",
    trigger: defaults.trigger ?? BUILTIN_DEFAULT_TRIGGER,
    drafts: false,
    minConfidence: 0.5,
    minInlinePriority: PROFILE_PRESETS.default.minInlinePriority,
    p2InlineMinConfidence: PROFILE_PRESETS.default.p2InlineMinConfidence,
    maxInline: 10,
    ignoreDefaults: true,
    ignore: [],
    language: "en",
    summary: false,
    postInformational: false,
  };
}

export type DropReason = "confidence" | "ignored";

export type AnchoredFinding = {
  finding: Finding;
  path: string;
  line: number;
  startLine?: number;
  /** True when the posted range is the finding's full start..end span, so a suggestion can replace it. */
  includeSuggestion: boolean;
};

export type ClassifiedReview = {
  dropped: Array<{ finding: Finding; reason: DropReason }>;
  /** New inline comments for this run, highest severity first, capped by maxInline. */
  inline: AnchoredFinding[];
  /** Actionable findings listed in the summary table, including ones already inlined or past the cap. */
  table: Finding[];
  /** Fresh actionable findings that did not fit in this run's inline cap. */
  overflow: Finding[];
  /** investigate, missing trigger, P3, and P2 below the inline confidence bar. */
  folded: Finding[];
  /** Line range does not overlap the diff. */
  outOfRange: Finding[];
  /** Findings still open after this run. The next push treats missing fingerprints as fixed. */
  open: Finding[];
  /**
   * Informational flags kept for the database and omitted from GitHub.
   * They are not open, so a later push does not mark a comment that was never posted as fixed.
   */
  withheld: Finding[];
};

/**
 * Split a `.dureview.md` file into prompt prose and a policy.
 * Config lives in YAML front matter. The rest of the file is the prompt rules.
 * A file with no front matter keeps the built-in policy.
 * An omitted `trigger` uses `defaults.trigger`, then `manual`.
 */
export function parseDureviewDocument(
  text: string,
  defaults: PolicyDefaults = {},
): { rules: string | null; policy: ReviewPolicy } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { rules: prose(text), policy: defaultPolicy(defaults) };
  }
  const policy = parseFrontMatter(match[1] ?? "", defaults);
  return { rules: prose(text.slice(match[0].length)), policy };
}

export function effectiveIgnore(policy: ReviewPolicy): readonly string[] {
  if (!policy.ignoreDefaults) return policy.ignore;
  return [...DEFAULT_IGNORE, ...policy.ignore];
}

export function isIgnoredPath(file: string, policy: ReviewPolicy): boolean {
  return effectiveIgnore(policy).some((glob) => matchGlob(glob, file));
}

export function classifyFindings(input: {
  findings: Finding[];
  diff: string;
  policy: ReviewPolicy;
  alreadyInlined?: ReadonlySet<string>;
}): ClassifiedReview {
  const already = input.alreadyInlined ?? new Set<string>();
  const lines = commentableLines(input.diff);
  const dropped: ClassifiedReview["dropped"] = [];
  const folded: Finding[] = [];
  const outOfRange: Finding[] = [];
  const withheld: Finding[] = [];
  const candidates: Array<{ finding: Finding; anchor: AnchoredFinding }> = [];

  for (const finding of dedupeFindings(input.findings)) {
    if (finding.confidence < input.policy.minConfidence) {
      dropped.push({ finding, reason: "confidence" });
      continue;
    }
    if (isIgnoredPath(finding.path, input.policy)) {
      dropped.push({ finding, reason: "ignored" });
      continue;
    }
    if (isInformational(finding) && !input.policy.postInformational) {
      withheld.push(finding);
      continue;
    }
    const anchor = anchorFinding(finding, lines);
    if (!anchor) {
      outOfRange.push(finding);
      continue;
    }
    if (foldFinding(finding, input.policy)) {
      folded.push(finding);
      continue;
    }
    candidates.push({ finding, anchor });
  }

  const bySeverity = (left: Finding, right: Finding) => compareFindings(left, right);
  candidates.sort((left, right) => bySeverity(left.finding, right.finding));
  folded.sort(bySeverity);
  outOfRange.sort(bySeverity);

  const fresh = candidates.filter((item) => !already.has(item.finding.fingerprint));
  const inline = fresh.slice(0, input.policy.maxInline).map((item) => item.anchor);
  const overflow = fresh.slice(input.policy.maxInline).map((item) => item.finding);
  const table = candidates.map((item) => item.finding);
  const open = [...table, ...folded, ...outOfRange];
  return { dropped, inline, table, overflow, folded, outOfRange, open, withheld };
}

export function matchGlob(glob: string, filePath: string): boolean {
  const file = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  let pattern = glob.replaceAll("\\", "/").trim();
  if (!pattern.includes("/")) pattern = `**/${pattern}`;
  return globToRegExp(pattern).test(file);
}

function foldFinding(finding: Finding, policy: ReviewPolicy): boolean {
  if (isInformational(finding)) {
    if (finding.priority > policy.minInlinePriority) return true;
    if (finding.priority === 2 && finding.confidence < policy.p2InlineMinConfidence) return true;
    return false;
  }
  if (finding.type === "flag" || finding.kind === "investigate" || finding.trigger.trim().length === 0) return true;
  if (finding.priority > policy.minInlinePriority) return true;
  if (finding.priority === 2 && finding.confidence < policy.p2InlineMinConfidence) return true;
  return false;
}

function anchorFinding(finding: Finding, lines: Map<string, Set<number>>): AnchoredFinding | null {
  const known = lines.get(finding.path);
  if (!known) return null;
  let first: number | undefined;
  let last: number | undefined;
  let full = true;
  for (let line = finding.startLine; line <= finding.endLine; line++) {
    if (known.has(line)) {
      if (first === undefined) first = line;
      last = line;
    } else {
      full = false;
    }
  }
  if (first === undefined || last === undefined) return null;
  const exact = full && first === finding.startLine && last === finding.endLine;
  if (!exact) {
    return { finding, path: finding.path, line: last, includeSuggestion: false };
  }
  return {
    finding,
    path: finding.path,
    line: last,
    ...(first !== last ? { startLine: first } : {}),
    includeSuggestion: finding.suggestion !== null,
  };
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();
  for (const finding of findings) {
    const existing = byFingerprint.get(finding.fingerprint);
    if (!existing || finding.confidence > existing.confidence) byFingerprint.set(finding.fingerprint, finding);
  }
  return [...byFingerprint.values()];
}

function compareFindings(left: Finding, right: Finding): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.startLine !== right.startLine) return left.startLine - right.startLine;
  if (left.title !== right.title) return left.title < right.title ? -1 : 1;
  return 0;
}

function prose(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 20_000) : null;
}

type ExplicitPolicy = {
  profile?: ReviewProfile;
  trigger?: ReviewTrigger;
  drafts?: boolean;
  minConfidence?: number;
  minInlinePriority?: Priority;
  p2InlineMinConfidence?: number;
  maxInline?: number;
  ignoreDefaults?: boolean;
  language?: ReviewLanguage;
  summary?: boolean;
  postInformational?: boolean;
};

function parseFrontMatter(body: string, defaults: PolicyDefaults): ReviewPolicy {
  const explicit: ExplicitPolicy = {};
  const seen = new Set<string>();
  let ignore: string[] = [];
  const lines = body.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }
    if (/^\s/.test(raw)) throw new ReviewConfigError(`Invalid .dureview.md config line: ${raw}`);
    const matched = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(raw);
    if (!matched?.[1]) throw new ReviewConfigError(`Invalid .dureview.md config line: ${raw}`);
    const key = matched[1];
    const value = matched[2] ?? "";
    if (seen.has(key)) throw new ReviewConfigError(`Duplicate .dureview.md key: ${key}`);
    seen.add(key);
    if (!KNOWN_KEYS.has(key)) throw new ReviewConfigError(`Unknown .dureview.md key: ${key}`);
    if (key === "ignore") {
      const parsed = parseIgnore(value, lines, index);
      ignore = parsed.items;
      index = parsed.next;
      continue;
    }
    if (value.trim() === "") throw new ReviewConfigError(`.dureview.md key ${key} needs a value.`);
    assignScalar(explicit, key, value.trim());
    index += 1;
  }
  return materializePolicy(explicit, ignore, defaults);
}

const KNOWN_KEYS = new Set([
  "profile",
  "trigger",
  "drafts",
  "language",
  "summary",
  "min_confidence",
  "min_inline_priority",
  "p2_inline_min_confidence",
  "max_inline",
  "ignore_defaults",
  "ignore",
  "post_informational",
]);

function parseIgnore(
  value: string,
  lines: string[],
  index: number,
): { items: string[]; next: number } {
  const trimmed = value.trim();
  if (trimmed === "[]") return { items: [], next: index + 1 };
  if (trimmed.startsWith("[")) return { items: parseFlowList(trimmed), next: index + 1 };
  if (trimmed !== "") throw new ReviewConfigError(`Invalid .dureview.md ignore value: ${value}`);
  const items: string[] = [];
  let next = index + 1;
  while (next < lines.length) {
    const line = lines[next] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) {
      next += 1;
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (!item?.[1]) break;
    items.push(unquote(item[1].trim()));
    next += 1;
  }
  return { items, next };
}

function parseFlowList(value: string): string[] {
  if (!value.endsWith("]")) throw new ReviewConfigError(`Invalid .dureview.md ignore list: ${value}`);
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((part) => unquote(part.trim())).filter((part) => part.length > 0);
}

function assignScalar(explicit: ExplicitPolicy, key: string, value: string): void {
  if (key === "profile") {
    if (value !== "quiet" && value !== "default" && value !== "loud") {
      throw new ReviewConfigError(`.dureview.md profile must be quiet, default, or loud, got ${value}.`);
    }
    explicit.profile = value;
    return;
  }
  if (key === "trigger") {
    if (value !== "auto" && value !== "once" && value !== "manual") {
      throw new ReviewConfigError(`.dureview.md trigger must be auto, once, or manual, got ${value}.`);
    }
    explicit.trigger = value;
    return;
  }
  if (key === "drafts") {
    explicit.drafts = parseBoolean(value, key);
    return;
  }
  if (key === "ignore_defaults") {
    explicit.ignoreDefaults = parseBoolean(value, key);
    return;
  }
  if (key === "summary") {
    explicit.summary = parseBoolean(value, key);
    return;
  }
  if (key === "post_informational") {
    explicit.postInformational = parseBoolean(value, key);
    return;
  }
  if (key === "language") {
    if (value !== "en" && value !== "zh") {
      throw new ReviewConfigError(`.dureview.md language must be en or zh, got ${value}.`);
    }
    explicit.language = value;
    return;
  }
  if (key === "min_confidence" || key === "p2_inline_min_confidence") {
    const number = parseNumber(value, key);
    if (number < 0 || number > 1) throw new ReviewConfigError(`.dureview.md ${key} must be between 0 and 1.`);
    if (key === "min_confidence") explicit.minConfidence = number;
    else explicit.p2InlineMinConfidence = number;
    return;
  }
  if (key === "min_inline_priority") {
    const number = parseInteger(value, key);
    if (number < 0 || number > 3) throw new ReviewConfigError(".dureview.md min_inline_priority must be 0, 1, 2, or 3.");
    explicit.minInlinePriority = number as Priority;
    return;
  }
  if (key === "max_inline") {
    const number = parseInteger(value, key);
    if (number < 0 || number > 100) throw new ReviewConfigError(".dureview.md max_inline must be an integer from 0 to 100.");
    explicit.maxInline = number;
  }
}

function materializePolicy(explicit: ExplicitPolicy, ignore: string[], defaults: PolicyDefaults): ReviewPolicy {
  if (ignore.length > 50) throw new ReviewConfigError(".dureview.md ignore accepts at most 50 globs.");
  for (const glob of ignore) {
    if (glob.length === 0 || glob.length > 200) throw new ReviewConfigError(`.dureview.md ignore glob is empty or too long: ${glob}`);
  }
  const profile = explicit.profile ?? "default";
  const preset = PROFILE_PRESETS[profile];
  return {
    profile,
    trigger: explicit.trigger ?? defaults.trigger ?? BUILTIN_DEFAULT_TRIGGER,
    drafts: explicit.drafts ?? false,
    minConfidence: explicit.minConfidence ?? 0.5,
    minInlinePriority: explicit.minInlinePriority ?? preset.minInlinePriority,
    p2InlineMinConfidence: explicit.p2InlineMinConfidence ?? preset.p2InlineMinConfidence,
    maxInline: explicit.maxInline ?? 10,
    ignoreDefaults: explicit.ignoreDefaults ?? true,
    ignore,
    language: explicit.language ?? "en",
    summary: explicit.summary ?? false,
    postInformational: explicit.postInformational ?? false,
  };
}

function parseBoolean(value: string, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ReviewConfigError(`.dureview.md ${key} must be true or false.`);
}

function parseNumber(value: string, key: string): number {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new ReviewConfigError(`.dureview.md ${key} must be a number from 0 to 1.`);
  return Number(value);
}

function parseInteger(value: string, key: string): number {
  if (!/^\d+$/.test(value)) throw new ReviewConfigError(`.dureview.md ${key} must be an integer.`);
  return Number(value);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function globToRegExp(glob: string): RegExp {
  let source = "^";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index];
    if (char === undefined) break;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  source += "$";
  return new RegExp(source);
}

export function foldedBucket(finding: Finding): "investigate" | "informational" | "p3" {
  if (isInformational(finding)) return "informational";
  if (finding.kind === "investigate" || finding.type === "flag" || finding.trigger.trim().length === 0 || finding.priority !== 3) {
    return "investigate";
  }
  return "p3";
}
