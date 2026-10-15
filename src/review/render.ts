import type { ReviewCommentDraft } from "../github/client.js";
import type { ReviewRequest } from "../types.js";
import { confidenceWord, formatConfidence } from "./confidence.js";
import { findingMarker, fixedMarker, ledgerMarker, type LedgerEntry } from "./ledger.js";
import { foldedBucket, type AnchoredFinding, type ClassifiedReview, type ReviewLanguage } from "./policy.js";
import { formatFindingType, type Finding, type ReviewSubmission, type Verdict } from "./schema.js";

type Copy = {
  verdict: Record<Verdict, string>;
  confidence: string;
  trigger: string;
  evidence: string;
  noTrigger: string;
  severity: string;
  finding: string;
  location: string;
  overflow: (count: number, max: number) => string;
  investigate: (count: number) => string;
  informational: (count: number) => string;
  p3: (count: number) => string;
  outOfRange: (count: number) => string;
  checked: string;
  noneListed: string;
  fixedHeading: string;
  fixedItem: (title: string, line: string, fingerprint: string) => string;
  overallConfidence: string;
  reason: (reason: string, detail: string) => string;
  evidenceJoiner: string;
  /** Colon (and following space, for English) after a bold label. */
  colon: string;
  fixedReply: (sha: string) => string;
};

const EN: Copy = {
  verdict: {
    block: "## dureview: Block",
    fix_recommended: "## dureview: Fix recommended",
    clean: "## dureview: Nothing to report",
  },
  confidence: "confidence",
  trigger: "Trigger",
  evidence: "Evidence",
  noTrigger: "(no trigger given)",
  severity: "Severity",
  finding: "Finding",
  location: "Location",
  overflow: (count, max) => `The other ${count} findings were not posted inline (this run's limit is ${max}).`,
  investigate: (count) => `Investigate (${count})`,
  informational: (count) => `Flag (${count})`,
  p3: (count) => `P3 (${count})`,
  outOfRange: (count) => `Out of range (${count})`,
  checked: "Checked",
  noneListed: "(none listed)",
  fixedHeading: "Fixed since the last review:",
  fixedItem: (title, line, fingerprint) => `- ${title} (${line} · fp:${fingerprint})`,
  overallConfidence: "overall confidence",
  reason: (reason, detail) => `${reason} (${detail})`,
  evidenceJoiner: ", ",
  colon: ": ",
  fixedReply: (sha) => `fixed in ${sha}`,
};

const ZH: Copy = {
  verdict: {
    block: "## dureview：建议阻断",
    fix_recommended: "## dureview：建议修复",
    clean: "## dureview：未发现问题",
  },
  confidence: "置信度",
  trigger: "触发条件",
  evidence: "证据",
  noTrigger: "（未给出触发条件）",
  severity: "级别",
  finding: "问题",
  location: "位置",
  overflow: (count, max) => `其余 ${count} 条未再发行内评论（本轮上限 ${max}）。`,
  investigate: (count) => `待核实（${count}）`,
  informational: (count) => `标注（${count}）`,
  p3: (count) => `P3（${count}）`,
  outOfRange: (count) => `范围外（${count}）`,
  checked: "已检查",
  noneListed: "（未列出）",
  fixedHeading: "上一轮已修复：",
  fixedItem: (title, line, fingerprint) => `- ${title}（${line} · fp:${fingerprint}）`,
  overallConfidence: "整体置信度",
  reason: (reason, detail) => `${reason}（${detail}）`,
  evidenceJoiner: "，",
  colon: "：",
  fixedReply: (sha) => `已在 ${sha} 修复`,
};

function copyFor(language: ReviewLanguage): Copy {
  return language === "zh" ? ZH : EN;
}

export function renderInlineComment(
  finding: Finding,
  includeSuggestion = finding.suggestion !== null,
  language: ReviewLanguage = "en",
): string {
  const copy = copyFor(language);
  const lines = [
    `${findingLead(finding, language, finding.title)} · ${finding.category}`,
    "",
    finding.body.trim(),
    `**${copy.trigger}**${copy.colon}${finding.trigger.trim() || copy.noTrigger}`,
  ];
  if (finding.evidence.length > 0) {
    lines.push(`**${copy.evidence}**${copy.colon}${finding.evidence.map((item) => `\`${item}\``).join(copy.evidenceJoiner)}`);
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

export function renderInlineDrafts(
  anchored: readonly AnchoredFinding[],
  language: ReviewLanguage = "en",
  taskId?: string,
): ReviewCommentDraft[] {
  return anchored.map((item) => {
    const body = renderInlineComment(item.finding, item.includeSuggestion, language);
    const marker = taskId === undefined ? "" : `\n${findingMarker(item.finding.fingerprint, taskId)}`;
    return {
      path: item.path,
      line: item.line,
      ...(item.startLine !== undefined ? { startLine: item.startLine } : {}),
      body: body + marker,
    };
  });
}

/** Reply used when a review thread cannot be resolved. The marker keeps a retry from replying twice. */
export function renderFixedReply(language: ReviewLanguage, sha: string, fingerprint: string): string {
  return `${copyFor(language).fixedReply(sha)}\n${fixedMarker(fingerprint, sha)}`;
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
  language?: ReviewLanguage;
}): string {
  const language = input.language ?? "en";
  const copy = copyFor(language);
  const lines = [
    copy.verdict[input.review.verdict],
    reasonLine(input.review, input.request.sha, copy),
  ];
  if (input.classified.table.length > 0) {
    lines.push("", `| ${copy.severity} | ${copy.finding} | ${copy.location} |`, "|---|---|---|");
    for (const finding of input.classified.table) {
      const label = locationLabel(finding);
      const href = blobUrl(input.request, finding.path, finding.startLine, finding.endLine);
      lines.push(`| ${cell(findingBadge(finding, language))} | ${cell(finding.title)} | [${cell(label)}](${href}) |`);
    }
    if (input.classified.overflow.length > 0) {
      lines.push("", copy.overflow(input.classified.overflow.length, input.maxInline));
    }
  }
  const folded = renderFolded(input.classified.folded, copy, language);
  if (folded) lines.push("", folded);
  const outside = renderOutside(input.classified.outOfRange, copy, language);
  if (outside) lines.push("", outside);
  lines.push("", renderChecked(input.review.checked, copy));
  if (input.fixed.length > 0) {
    lines.push("", copy.fixedHeading);
    for (const entry of input.fixed) {
      const line = entry.start === entry.end ? `${entry.path}:${entry.start}` : `${entry.path}:${entry.start}-${entry.end}`;
      lines.push(copy.fixedItem(entry.title, line, entry.fp));
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

function reasonLine(review: ReviewSubmission, sha: string, copy: Copy): string {
  const head = `head ${sha.slice(0, 7)}`;
  const confidence =
    review.overallConfidence === null ? head : `${copy.overallConfidence} ${formatConfidence(review.overallConfidence)} · ${head}`;
  return copy.reason(review.verdictReason, confidence);
}

function renderFolded(findings: readonly Finding[], copy: Copy, language: ReviewLanguage): string | null {
  if (findings.length === 0) return null;
  const informational = findings.filter((finding) => foldedBucket(finding) === "informational").length;
  const investigate = findings.filter((finding) => foldedBucket(finding) === "investigate").length;
  const p3 = findings.length - investigate - informational;
  const parts: string[] = [];
  if (investigate > 0) parts.push(copy.investigate(investigate));
  if (informational > 0) parts.push(copy.informational(informational));
  if (p3 > 0) parts.push(copy.p3(p3));
  const lines = [`<details>`, `<summary>${parts.join(" / ")}</summary>`, ""];
  for (const finding of findings) lines.push(foldedLine(finding, copy, language));
  lines.push("", "</details>");
  return lines.join("\n");
}

function renderOutside(findings: readonly Finding[], copy: Copy, language: ReviewLanguage): string | null {
  if (findings.length === 0) return null;
  const lines = [`<details>`, `<summary>${copy.outOfRange(findings.length)}</summary>`, ""];
  for (const finding of findings) lines.push(foldedLine(finding, copy, language));
  lines.push("", "</details>");
  return lines.join("\n");
}

function renderChecked(checked: readonly string[], copy: Copy): string {
  const lines = ["<details>", `<summary>${copy.checked}</summary>`, ""];
  if (checked.length === 0) lines.push(`- ${copy.noneListed}`);
  else for (const item of checked) lines.push(`- ${oneLine(item)}`);
  lines.push("", "</details>");
  return lines.join("\n");
}

function findingBadge(finding: Finding, language: ReviewLanguage): string {
  return (
    formatFindingType({
      type: finding.type,
      subtype: finding.subtype,
      cwe: finding.cwe,
      priority: finding.priority,
      language,
    }) ?? `P${finding.priority}`
  );
}

function findingLead(finding: Finding, language: ReviewLanguage, title: string): string {
  const copy = copyFor(language);
  const badge = findingBadge(finding, language);
  return `**${badge}** · ${copy.confidence} ${confidenceWord(finding.confidence, language)} · **${title}**`;
}

function foldedLine(finding: Finding, copy: Copy, language: ReviewLanguage): string {
  const trigger = finding.trigger.trim() || copy.noTrigger;
  return `- ${findingLead(finding, language, oneLine(finding.title))} · \`${locationLabel(finding)}\` — ${oneLine(finding.body)} **${copy.trigger}**${copy.colon}${oneLine(trigger)}`;
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
