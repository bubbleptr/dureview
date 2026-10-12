import { createHash } from "node:crypto";
import { Type, type Static } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
import { Value } from "typebox/value";

/** Highest number of findings stored from one model call. Inline posting is capped separately. */
export const MAX_FINDINGS = 30;

const nullableString = (maxLength: number) => Type.Union([Type.String({ maxLength }), Type.Null()]);

export const FindingSchema = Type.Object(
  {
    title: Type.String({ maxLength: 80, minLength: 1, description: "At most 80 characters. Say what to fix." }),
    priority: Type.Integer({ minimum: 0, maximum: 3, description: "0 = P0, 1 = P1, 2 = P2, 3 = P3" }),
    kind: StringEnum(["bug", "security", "investigate"], {
      description: "bug or security when you can name a trigger. investigate when you only suspect it.",
    }),
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
    cwe: Type.Optional(nullableString(40)),
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
    parsed = Value.Parse(ReviewSubmissionSchema, raw);
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
  return {
    title,
    priority: asPriority(raw.priority),
    kind: asKind(raw.kind),
    category: asCategory(raw.category),
    path,
    startLine: raw.start_line,
    endLine: raw.end_line,
    body: raw.body.trim(),
    trigger: raw.trigger.trim(),
    evidence: (raw.evidence ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
    suggestion,
    cwe: cleanOptionalText(raw.cwe),
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

function asKind(value: string): FindingKind {
  if (value === "bug" || value === "security" || value === "investigate") return value;
  throw new Error("submit_review payload is invalid: kind must be bug, security, or investigate.");
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
