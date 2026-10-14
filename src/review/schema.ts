import { createHash } from "node:crypto";
import { Type, type Static } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
import { Value } from "typebox/value";

/** Highest number of findings stored from one model call. Inline posting is capped separately. */
export const MAX_FINDINGS = 30;

const nullableString = (maxLength: number, description?: string) =>
  Type.Union([Type.String({ maxLength, ...(description ? { description } : {}) }), Type.Null()]);

export const FindingSchema = Type.Object(
  {
    title: Type.String({ maxLength: 80, minLength: 1, description: "At most 80 characters. Say what to fix." }),
    priority: Type.Integer({ minimum: 0, maximum: 3, description: "0 = P0, 1 = P1, 2 = P2, 3 = P3" }),
    kind: StringEnum(["bug", "security", "investigate"], {
      description: "bug or security when you can name a trigger. investigate when you only suspect it. Match type: bug, security, or flag.",
    }),
    type: Type.Optional(
      Type.String({
        maxLength: 40,
        description:
          "Orthogonal to priority. bug (confirmed error), flag (annotation), or security (vulnerability). Required on new reviews.",
      }),
    ),
    subtype: Type.Optional(
      Type.String({
        maxLength: 40,
        description:
          "bug: severe or non_severe. flag: investigate or informational. security: critical or warning.",
      }),
    ),
    category: StringEnum(
      [
        "correctness",
        "security",
        "data_integrity",
        "concurrency",
        "error_handling",
        "performance",
        "api_contract",
        "test_gap",
      ],
      { description: "Topic of the finding. Orthogonal to kind and priority." },
    ),
    path: Type.String({ minLength: 1, description: "Path relative to the repository root" }),
    start_line: Type.Integer({ minimum: 1, description: "First line of the finding in the head file" }),
    end_line: Type.Integer({ minimum: 1, description: "Last line of the finding in the head file" }),
    body: Type.String({
      minLength: 1,
      maxLength: 8_000,
      description: "One paragraph: why this is wrong, naming the affected caller when there is one.",
    }),
    trigger: Type.String({
      maxLength: 2_000,
      description: "Concrete input, environment, or ordering. Empty only for investigate.",
    }),
    evidence: Type.Optional(
      Type.Array(Type.String({ maxLength: 200 }), {
        maxItems: 10,
        description: "path:line locations that prove the affected code",
      }),
    ),
    suggestion: Type.Optional(nullableString(8_000)),
    cwe: Type.Optional(
      nullableString(40, "CWE id such as CWE-89 for a security finding, or null when you do not know it."),
    ),
    rule_ref: Type.Optional(nullableString(200)),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export const ReviewSubmissionSchema = Type.Object(
  {
    verdict: StringEnum(["block", "fix_recommended", "clean"]),
    verdict_reason: Type.String({ maxLength: 300, minLength: 1 }),
    overall_confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    checked: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 6,
      description: "Risk areas actually inspected, for example concurrent duplicate delivery.",
    }),
    findings: Type.Array(FindingSchema, { maxItems: MAX_FINDINGS }),
  },
  { additionalProperties: false },
);

export type Verdict = "block" | "fix_recommended" | "clean";
export type Priority = 0 | 1 | 2 | 3;
export type FindingKind = "bug" | "security" | "investigate";
/** Devin-style finding class. Orthogonal to P0–P3 priority and to category. */
export type FindingType = "bug" | "flag" | "security";
export type FindingSubtype = "severe" | "non_severe" | "investigate" | "informational" | "critical" | "warning";
export type FindingCategory =
  | "correctness"
  | "security"
  | "data_integrity"
  | "concurrency"
  | "error_handling"
  | "performance"
  | "api_contract"
  | "test_gap";

export type Finding = {
  title: string;
  priority: Priority;
  kind: FindingKind;
  /** bug, flag, or security. Orthogonal to priority. */
  type: FindingType;
  subtype: FindingSubtype;
  category: FindingCategory;
  path: string;
  startLine: number;
  endLine: number;
  body: string;
  trigger: string;
  evidence: string[];
  suggestion: string | null;
  cwe: string | null;
  ruleRef: string | null;
  confidence: number;
  /** sha256(path + category + normalized title), 12 hex chars. Computed on the server. */
  fingerprint: string;
};

export type ReviewSubmission = {
  verdict: Verdict;
  verdictReason: string;
  overallConfidence: number | null;
  checked: string[];
  findings: Finding[];
};

type ParsedSubmission = Static<typeof ReviewSubmissionSchema>;

export function parseReviewSubmission(raw: unknown): ReviewSubmission {
  let parsed: ParsedSubmission;
  try {
    parsed = Value.Parse(ReviewSubmissionSchema, coerceSubmission(raw));
  } catch (error) {
    throw new Error(`submit_review payload is invalid: ${formatParseError(error)}`);
  }
  return {
    verdict: asVerdict(parsed.verdict),
    verdictReason: parsed.verdict_reason.trim(),
    overallConfidence: parsed.overall_confidence ?? null,
    checked: parsed.checked.map((item) => item.trim()),
    findings: parsed.findings.map((finding) => normalizeFinding(finding)),
  };
}

export function findingFingerprint(input: { path: string; category: string; title: string }): string {
  const path = normalizeRepoPath(input.path);
  const title = normalizeTitle(input.title);
  return createHash("sha256").update(`${path}\0${input.category}\0${title}`).digest("hex").slice(0, 12);
}

export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeRepoPath(path: string): string {
  const file = path.replaceAll("\\", "/").replace(/^\.\//, "").trim();
  if (!file || file.startsWith("/") || file.split("/").includes("..")) {
    throw new Error(`Finding path must stay inside the repository: ${path}`);
  }
  return file;
}

function normalizeFinding(raw: ParsedSubmission["findings"][number]): Finding {
  const path = normalizeRepoPath(raw.path);
  if (raw.end_line < raw.start_line) {
    throw new Error(`Finding ${path} end_line must be greater than or equal to start_line.`);
  }
  const title = raw.title.trim();
  const suggestion = cleanOptionalText(raw.suggestion);
  const priority = asPriority(raw.priority);
  const classification = resolveFindingClassification({
    kind: raw.kind,
    priority,
    type: raw.type,
    subtype: raw.subtype,
  });
  return {
    title,
    priority,
    kind: classification.kind,
    type: classification.type,
    subtype: classification.subtype,
    category: asCategory(raw.category),
    path,
    startLine: raw.start_line,
    endLine: raw.end_line,
    body: raw.body.trim(),
    trigger: raw.trigger.trim(),
    evidence: (raw.evidence ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
    suggestion,
    cwe: normalizeCwe(cleanOptionalText(raw.cwe)),
    ruleRef: cleanOptionalText(raw.rule_ref),
    confidence: raw.confidence,
    fingerprint: findingFingerprint({ path, category: raw.category, title }),
  };
}

function asVerdict(value: string): Verdict {
  if (value === "block" || value === "fix_recommended" || value === "clean") return value;
  throw new Error("submit_review payload is invalid: verdict must be block, fix_recommended, or clean.");
}

function asPriority(value: number): Priority {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  throw new Error("submit_review payload is invalid: priority must be 0, 1, 2, or 3.");
}

const SUBTYPES: Record<FindingType, readonly FindingSubtype[]> = {
  bug: ["severe", "non_severe"],
  flag: ["investigate", "informational"],
  security: ["critical", "warning"],
};

const TYPE_LABELS = {
  en: { bug: "Bug", flag: "Flag", security: "Security" },
  zh: { bug: "缺陷", flag: "标注", security: "安全" },
} as const;

const SUBTYPE_LABELS = {
  en: {
    severe: "severe",
    non_severe: "non-severe",
    investigate: "investigate",
    informational: "informational",
    critical: "Critical",
    warning: "Warning",
  },
  zh: {
    severe: "严重",
    non_severe: "一般",
    investigate: "待核实",
    informational: "说明",
    critical: "严重",
    warning: "警告",
  },
} as const;

/** True for a flag that explains behavior or confirms correctness and asks for no change. */
export function isInformational(finding: { type?: string | null; subtype?: string | null }): boolean {
  return finding.type === "flag" && finding.subtype === "informational";
}

/**
 * Fill type and subtype when an older or malformed payload omits them or pairs them badly.
 * Kind follows type: bug, security, or investigate for either flag subtype.
 * Priority only chooses the default subtype. It does not choose the type.
 */
export function resolveFindingClassification(input: {
  kind: string;
  priority: number;
  type?: string | null;
  subtype?: string | null;
}): { type: FindingType; subtype: FindingSubtype; kind: FindingKind } {
  const kind = parseKind(input.kind) ?? "bug";
  const priority = input.priority === 0 || input.priority === 1 || input.priority === 2 || input.priority === 3 ? input.priority : 1;
  const typeToken = token(input.type);
  const subtypeToken = token(input.subtype);
  let type = parseType(typeToken);
  const hinted = parseSubtype(subtypeToken);
  if (!type && hinted) type = typeForSubtype(hinted);
  if (!type) type = typeForKind(kind);
  const subtype = hinted && subtypeMatches(type, hinted) ? hinted : defaultSubtype(type, priority, kind);
  return { type, subtype, kind: kindForType(type) };
}

/**
 * `P1 · Bug (severe)`, `P0 · Security · Critical · CWE-89`.
 * Returns null when the stored type is missing, which is how rows from before this column render.
 */
export function formatFindingType(input: {
  type?: string | null;
  subtype?: string | null;
  cwe?: string | null;
  priority?: number | null;
  language?: "en" | "zh";
}): string | null {
  const type = parseType(token(input.type));
  const subtype = parseSubtype(token(input.subtype));
  if (!type || !subtype || !subtypeMatches(type, subtype)) return null;
  const language = input.language === "zh" ? "zh" : "en";
  const typeLabel = TYPE_LABELS[language][type];
  const subtypeLabel = SUBTYPE_LABELS[language][subtype];
  const body = type === "security" ? `${typeLabel} · ${subtypeLabel}` : `${typeLabel} (${subtypeLabel})`;
  const cwe = normalizeCwe(input.cwe);
  const prefix =
    input.priority === 0 || input.priority === 1 || input.priority === 2 || input.priority === 3
      ? `P${input.priority} · `
      : "";
  return `${prefix}${body}${cwe ? ` · ${cwe}` : ""}`;
}

/** `CWE-89`, `cwe-89`, and `89` become `CWE-89`. Anything else is dropped. */
export function normalizeCwe(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(?:CWE[-\s:]*)?(\d{1,5})$/i.exec(trimmed);
  const digits = match?.[1];
  if (!digits) return null;
  const id = String(Number(digits));
  if (id === "0") return null;
  return `CWE-${id}`;
}

function coerceSubmission(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.findings)) return raw;
  return {
    ...raw,
    findings: raw.findings.map((item) => {
      if (!isRecord(item)) return item;
      const next: Record<string, unknown> = { ...item };
      if (next.type !== undefined && typeof next.type !== "string") delete next.type;
      if (next.subtype !== undefined && typeof next.subtype !== "string") delete next.subtype;
      if (next.cwe !== undefined && next.cwe !== null && typeof next.cwe !== "string") {
        next.cwe = typeof next.cwe === "number" && Number.isInteger(next.cwe) ? String(next.cwe) : null;
      }
      return next;
    }),
  };
}

function parseKind(value: string): FindingKind | null {
  if (value === "bug" || value === "security" || value === "investigate") return value;
  return null;
}

function parseType(value: string): FindingType | null {
  if (value === "bug" || value === "flag" || value === "security") return value;
  return null;
}

function parseSubtype(value: string): FindingSubtype | null {
  if (
    value === "severe" ||
    value === "non_severe" ||
    value === "investigate" ||
    value === "informational" ||
    value === "critical" ||
    value === "warning"
  ) {
    return value;
  }
  return null;
}

function subtypeMatches(type: FindingType, subtype: FindingSubtype): boolean {
  return SUBTYPES[type].includes(subtype);
}

function typeForSubtype(subtype: FindingSubtype): FindingType {
  if (subtype === "severe" || subtype === "non_severe") return "bug";
  if (subtype === "critical" || subtype === "warning") return "security";
  return "flag";
}

function typeForKind(kind: FindingKind): FindingType {
  if (kind === "security") return "security";
  if (kind === "investigate") return "flag";
  return "bug";
}

function kindForType(type: FindingType): FindingKind {
  if (type === "security") return "security";
  if (type === "flag") return "investigate";
  return "bug";
}

function defaultSubtype(type: FindingType, priority: Priority, kind: FindingKind): FindingSubtype {
  if (type === "bug") return priority <= 1 ? "severe" : "non_severe";
  if (type === "security") return priority <= 1 ? "critical" : "warning";
  return kind === "investigate" ? "investigate" : "informational";
}

function token(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCategory(value: string): FindingCategory {
  if (
    value === "correctness" ||
    value === "security" ||
    value === "data_integrity" ||
    value === "concurrency" ||
    value === "error_handling" ||
    value === "performance" ||
    value === "api_contract" ||
    value === "test_gap"
  ) {
    return value;
  }
  throw new Error("submit_review payload is invalid: category is not recognized.");
}

function cleanOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.replace(/\s+$/u, "");
  return trimmed.trim().length === 0 ? null : trimmed;
}

function formatParseError(error: unknown): string {
  if (error instanceof Error && error.cause && typeof error.cause === "object" && "errors" in error.cause) {
    const errors = (error.cause as { errors?: Array<{ instancePath?: string; message?: string }> }).errors ?? [];
    const detail = errors
      .slice(0, 4)
      .map((item) => `${item.instancePath || "/"} ${item.message ?? "invalid"}`.trim())
      .join("; ");
    if (detail) return detail;
  }
  return error instanceof Error ? error.message : String(error);
}
