import type { ReviewCommentDraft } from "../github/client.js";
import type { ReviewRequest } from "../types.js";
import { ledgerMarker, type LedgerEntry } from "./ledger.js";
import { foldedBucket, type AnchoredFinding, type ClassifiedReview } from "./policy.js";
import type { Finding, FindingKind, ReviewSubmission } from "./schema.js";

const KIND_EMOJI: Record<FindingKind, string> = {
  bug: "🐛",
  security: "🔒",
  investigate: "🔎",
};

const VERDICT_HEADING = {
  block: "## dureview：⛔ 建议阻断",
  fix_recommended: "## dureview：⚠️ 建议修复",
  clean: "## dureview：✅ 未发现问题",
} as const;

export function renderInlineComment(finding: Finding, includeSuggestion = finding.suggestion !== null): string {
  const emoji = KIND_EMOJI[finding.kind];
  const cwe = finding.cwe ? ` · ${finding.cwe}` : "";
  const lines = [
    `**[P${finding.priority}] ${emoji} ${finding.title}**  · ${finding.category} · 置信度 ${formatConfidence(finding.confidence)}${cwe}`,
    "",
    finding.body.trim(),
    `**触发条件**：${finding.trigger.trim() || "（未给出触发条件）"}`,
  ];
  if (finding.evidence.length > 0) {
    lines.push(`**证据**：${finding.evidence.map((item) => `\`${item}\``).join("，")}`);
  }
  const rule = finding.ruleRef ? ` · ${finding.ruleRef}` : "";
  const footer = `<sub>dureview · fp:${finding.fingerprint}${rule}</sub>`;
  if (includeSuggestion && finding.suggestion) {
    lines.push("", "```suggestion", finding.suggestion, "```", footer);
  } else {
    lines.push("", footer);
  }
  return lines.join("\n");
}

export function renderInlineDrafts(anchored: readonly AnchoredFinding[]): ReviewCommentDraft[] {
  return anchored.map((item) => ({
    path: item.path,
    line: item.line,
    ...(item.startLine !== undefined ? { startLine: item.startLine } : {}),
    body: renderInlineComment(item.finding, item.includeSuggestion),
  }));
}

export function renderSummary(input: {
  request: Pick<ReviewRequest, "owner" | "repo" | "sha" | "cloneUrl">;
  provider: string;
  modelId: string;
  review: ReviewSubmission;
  classified: ClassifiedReview;
  fixed: LedgerEntry[];
  summaryTag: string;
  taskTag: string;
  maxInline: number;
}): string {
  const lines = [
    VERDICT_HEADING[input.review.verdict],
    reasonLine(input.review, input.request.sha),
  ];
  if (input.classified.table.length > 0) {
    lines.push("", "| 级别 | 问题 | 位置 |", "|---|---|---|");
    for (const finding of input.classified.table) {
      const label = locationLabel(finding);
      const href = blobUrl(input.request, finding.path, finding.startLine, finding.endLine);
      lines.push(`| P${finding.priority} | ${cell(finding.title)} | [${cell(label)}](${href}) |`);
    }
    if (input.classified.overflow.length > 0) {
      lines.push("", `其余 ${input.classified.overflow.length} 条未再发行内评论（本轮上限 ${input.maxInline}）。`);
    }
  }
  const folded = renderFolded(input.classified.folded);
  if (folded) lines.push("", folded);
  const outside = renderOutside(input.classified.outOfRange);
  if (outside) lines.push("", outside);
  lines.push("", renderChecked(input.review.checked));
  if (input.fixed.length > 0) {
    lines.push("", "✔ 上一轮已修复：");
    for (const entry of input.fixed) {
      const line = entry.start === entry.end ? `${entry.path}:${entry.start}` : `${entry.path}:${entry.start}-${entry.end}`;
      lines.push(`- ${entry.title}（${line} · fp:${entry.fp}）`);
    }
  }
  lines.push(
    "",
    `<sub>${input.provider}/${input.modelId}</sub>`,
    "",
    input.summaryTag,
    input.taskTag,
    ledgerMarker(input.classified.open.map((finding) => ({
      fp: finding.fingerprint,
      title: finding.title,
      path: finding.path,
      start: finding.startLine,
      end: finding.endLine,
      priority: finding.priority,
      kind: finding.kind,
    }))),
  );
  return lines.join("\n");
}

export function formatConfidence(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function blobUrl(
  request: Pick<ReviewRequest, "owner" | "repo" | "sha" | "cloneUrl">,
  path: string,
  start: number,
  end: number,
): string {
  const hash = start === end ? `#L${start}` : `#L${start}-L${end}`;
  const encoded = path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${htmlBase(request)}/blob/${request.sha}/${encoded}${hash}`;
}

function reasonLine(review: ReviewSubmission, sha: string): string {
  const head = `head ${sha.slice(0, 7)}`;
  const confidence =
    review.overallConfidence === null ? head : `整体置信度 ${formatConfidence(review.overallConfidence)} · ${head}`;
  return `${review.verdictReason}（${confidence}）`;
}

function renderFolded(findings: readonly Finding[]): string | null {
  if (findings.length === 0) return null;
  const investigate = findings.filter((finding) => foldedBucket(finding) === "investigate").length;
  const p3 = findings.length - investigate;
  const parts: string[] = [];
  if (investigate > 0) parts.push(`🔎 待核实（${investigate}）`);
  if (p3 > 0) parts.push(`P3（${p3}）`);
  const lines = [`<details>`, `<summary>${parts.join(" / ")}</summary>`, ""];
  for (const finding of findings) lines.push(foldedLine(finding));
  lines.push("", "</details>");
  return lines.join("\n");
}

function renderOutside(findings: readonly Finding[]): string | null {
  if (findings.length === 0) return null;
  const lines = [`<details>`, `<summary>范围外（${findings.length}）</summary>`, ""];
  for (const finding of findings) lines.push(foldedLine(finding));
  lines.push("", "</details>");
  return lines.join("\n");
}

function renderChecked(checked: readonly string[]): string {
  const lines = ["<details>", "<summary>已检查</summary>", ""];
  if (checked.length === 0) lines.push("- （未列出）");
  else for (const item of checked) lines.push(`- ${oneLine(item)}`);
  lines.push("", "</details>");
  return lines.join("\n");
}

function foldedLine(finding: Finding): string {
  const emoji = KIND_EMOJI[finding.kind];
  const trigger = finding.trigger.trim() || "（未给出触发条件）";
  return `- **[P${finding.priority}] ${emoji} ${oneLine(finding.title)}** · \`${locationLabel(finding)}\` — ${oneLine(finding.body)} **触发条件**：${oneLine(trigger)}`;
}

function locationLabel(finding: Pick<Finding, "path" | "startLine" | "endLine">): string {
  if (finding.startLine === finding.endLine) return `${finding.path}:${finding.startLine}`;
  return `${finding.path}:${finding.startLine}-${finding.endLine}`;
}

function htmlBase(request: Pick<ReviewRequest, "owner" | "repo" | "cloneUrl">): string {
  const stripped = request.cloneUrl.replace(/\.git$/, "").replace(/\/$/, "");
  if (/^https?:\/\//.test(stripped)) return stripped;
  return `https://github.com/${request.owner}/${request.repo}`;
}

function cell(value: string): string {
  return oneLine(value).replace(/\|/g, "\\|");
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
