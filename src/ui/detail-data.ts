import type { PullFile } from "../github/client.js";
import { reviewResult, type ReviewDetail, type StoredComment } from "../review/archive.js";
import { formatFindingType } from "../review/schema.js";
import type { DureviewService } from "../service.js";
import { fileStatusMark, placeReview, type PlacedLine } from "./diff.js";
import type { Locale } from "./locale.js";
import { messages } from "./messages.js";
import type {
  DetailCommentView,
  DetailCount,
  DetailFileView,
  DetailLineView,
  DetailSettings,
  DetailSummary,
  ReviewDetailHeader,
  ReviewDetailModel,
} from "./detail-model.js";
import {
  displayTrigger,
  formatDuration,
  formatTime,
  pullRequestUrl,
  resultLabel,
  reviewDurationMs,
  runningLabel,
} from "./page.js";
import type { ReviewTreePreload } from "./review-presentation.js";

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type DetailPayload =
  | { kind: "login"; next: string }
  | { kind: "missing" }
  | { kind: "error" }
  | { kind: "detail"; model: ReviewDetailModel; tree: ReviewTreePreload | null };

export type ReviewHeaderPayload =
  | { kind: "login"; next: string }
  | { kind: "missing" }
  | { kind: "header"; header: ReviewDetailHeader };

/** Title and result for the shell. Does not load the pull request diff. */
export async function loadReviewHeader(
  service: DureviewService,
  githubApiUrl: string,
  taskId: string,
  now = Date.now(),
  locale: Locale = "en",
): Promise<ReviewDetailHeader | null> {
  if (!TASK_ID.test(taskId)) return null;
  const review = await service.savedReview(taskId);
  if (!review) return null;
  return reviewHeader(review, githubApiUrl, now, locale);
}

/**
 * Saved review plus the pull request diff.
 * Returns null when the task id is unknown. A GitHub failure is still a model,
 * with `diffUnavailable` set, so the saved comments can render.
 */
export async function loadReviewDetail(
  service: DureviewService,
  githubApiUrl: string,
  taskId: string,
  now = Date.now(),
  locale: Locale = "en",
): Promise<ReviewDetailModel | null> {
  if (!TASK_ID.test(taskId)) return null;
  const detail = await service.reviewForUi(taskId, AbortSignal.timeout(20_000));
  if (!detail) return null;
  return buildReviewDetail({
    review: detail.review,
    files: detail.files,
    diffUnavailable: detail.diffUnavailable,
    githubApiUrl,
    now,
    locale,
  });
}

/** Turn an archive row and the GitHub file list into the detail view model. */
export function buildReviewDetail(input: {
  review: ReviewDetail;
  files: PullFile[];
  diffUnavailable: boolean;
  githubApiUrl: string;
  now?: number;
  locale?: Locale;
}): ReviewDetailModel {
  const now = input.now ?? Date.now();
  const locale = input.locale ?? "en";
  const review = input.review;
  const placed = placeReview(input.files, review.comments);
  const copy = messages[locale].detail;
  return {
    ...reviewHeader(review, input.githubApiUrl, now, locale),
    diffUnavailable: input.diffUnavailable,
    hiddenFiles: placed.hiddenFiles,
    noChangedFiles: placed.files.length === 0 && !input.diffUnavailable,
    outsideTitle: placed.files.length === 0 && !input.diffUnavailable ? copy.outsideComments : copy.outsideFiles,
    files: placed.files.map((file) => fileView(file, locale)),
    outside: placed.outside.map((comment) => commentView(comment, locale)),
    summary: summaryView(review, now, locale),
    settings: settingsView(review),
  };
}

export function reviewHeader(review: ReviewDetail, githubApiUrl: string, now = Date.now(), locale: Locale = "en"): ReviewDetailHeader {
  const kind = reviewResult(review);
  const whenIso = review.finishedAt ?? review.startedAt;
  const pullLabel = `${review.owner}/${review.repo} #${review.number}`;
  return {
    pageTitle: pullLabel,
    backHref: "/ui/reviews",
    pullHref: pullRequestUrl(githubApiUrl, review.owner, review.repo, review.number),
    pullLabel,
    heading: review.title || messages[locale].detail.untitled,
    resultKind: kind,
    resultText: resultLabel(kind, locale),
    triggerLabel: displayTrigger(review.trigger, locale),
    duration:
      review.outcome === "running"
        ? runningLabel(review.startedAt, now, locale)
        : formatDuration(reviewDurationMs(review.startedAt, review.finishedAt, now)),
    whenIso,
    whenLabel: formatTime(whenIso, locale),
  };
}

function findingLanguage(locale: Locale): "en" | "zh" {
  return locale === "zh-CN" ? "zh" : "en";
}

function fileView(file: {
  anchor: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  lines: PlacedLine[];
  unanchored: StoredComment[];
  patchMissing: boolean;
  patchTruncated: boolean;
  diffText: string | null;
}, locale: Locale): DetailFileView {
  return {
    anchor: file.anchor,
    filename: file.filename,
    status: file.status,
    statusMark: fileStatusMark(file.status),
    stats: file.patchMissing ? null : `+${file.additions} −${file.deletions}`,
    patchMissing: file.patchMissing,
    patchTruncated: file.patchTruncated,
    diffText: file.diffText,
    lines: file.lines.map((line) => lineView(line, locale)),
    unanchored: file.unanchored.map((comment) => commentView(comment, locale)),
  };
}

function lineView(line: PlacedLine, locale: Locale): DetailLineView {
  return {
    kind: line.kind,
    oldLabel: line.oldLine === null ? "" : String(line.oldLine),
    newLabel: line.newLine === null ? "" : String(line.newLine),
    mark: line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "context" ? " " : "",
    text: line.text,
    severity: line.severity,
    comments: line.comments.map((item) => commentView(item, locale)),
  };
}

function commentView(comment: StoredComment, locale: Locale): DetailCommentView {
  return {
    ordinal: comment.ordinal,
    anchor: `c-${comment.ordinal}`,
    priority: comment.priority,
    typeLabel: formatFindingType({ type: comment.findingType, subtype: comment.subtype, language: findingLanguage(locale) }),
    tags: commentTags(comment.kind, comment.category),
    confidence: `${Math.round(comment.confidence * 100)}%`,
    title: comment.title,
    body: comment.body,
    trigger: comment.trigger,
    evidence: comment.evidence,
    suggestion: comment.suggestion,
    path: comment.path,
    startLine: comment.startLine,
    endLine: comment.endLine,
  };
}

/** One tag when kind and category are the same word. Empty strings are dropped. */
function commentTags(kind: string, category: string): string[] {
  const left = kind.trim();
  const right = category.trim();
  if (left.length > 0 && left.toLowerCase() === right.toLowerCase()) return [left];
  const tags: string[] = [];
  if (left.length > 0) tags.push(left);
  if (right.length > 0 && right.toLowerCase() !== left.toLowerCase()) tags.push(right);
  return tags;
}

function summaryView(review: ReviewDetail, now: number, locale: Locale): DetailSummary {
  const kind = reviewResult(review);
  const resultText = resultLabel(kind, locale);
  if (review.outcome !== "completed") {
    const note = review.outcome === "failed" ? review.error || messages[locale].detail.failedNoReason : runningLabel(review.startedAt, now, locale);
    return { mode: "incomplete", resultKind: kind, resultText, note };
  }
  const verdict = verdictView(review.verdict, locale);
  return {
    mode: "complete",
    resultKind: kind,
    resultText,
    verdictLabel: verdict?.label ?? null,
    verdictKind: verdict?.kind ?? null,
    reason: review.verdictReason,
    counts: priorityCounts(review),
    findings: review.comments.map((comment) => ({
      anchor: `c-${comment.ordinal}`,
      priority: comment.priority,
      typeLabel: formatFindingType({ type: comment.findingType, subtype: comment.subtype, language: findingLanguage(locale) }),
      title: comment.title,
      where: `${comment.path}:${comment.startLine}`,
    })),
    checked: review.checked,
    noComments: review.comments.length === 0,
  };
}

function priorityCounts(review: ReviewDetail): DetailCount[] {
  const known = review.countsKnown;
  return [
    { label: "P0", value: countText(review.p0, known), on: known && review.p0 > 0 },
    { label: "P1", value: countText(review.p1, known), on: known && review.p1 > 0 },
    { label: "P2", value: countText(review.p2, known), on: known && review.p2 > 0 },
    { label: "P3", value: countText(review.p3, known), on: known && review.p3 > 0 },
  ];
}

function countText(count: number, known: boolean): string {
  return known ? String(count) : "—";
}

function verdictView(verdict: string | null, locale: Locale): { label: string; kind: "pass" | "suggest" | "blocker" } | null {
  if (!verdict) return null;
  const copy = messages[locale].status;
  if (verdict === "fix_recommended") return { label: copy.verdictFix, kind: "suggest" };
  if (verdict === "block") return { label: copy.verdictBlock, kind: "blocker" };
  if (verdict === "clean") return { label: copy.verdictClean, kind: "pass" };
  return { label: verdict, kind: "pass" };
}

function settingsView(review: ReviewDetail): DetailSettings {
  const policy = review.policy;
  if (!policy) return { recorded: false };
  const model = [review.provider, review.model].filter((part) => part && part.length > 0).join("/");
  const rows: Array<{ key: string; value: string }> = [
    { key: "trigger", value: policy.trigger },
    { key: "drafts", value: policy.drafts ? "true" : "false" },
    { key: "profile", value: policy.profile },
    { key: "language", value: policy.language },
    { key: "summary", value: policy.summary ? "true" : "false" },
    { key: "post informational", value: policy.postInformational ? "true" : "false" },
    { key: "min confidence", value: String(policy.minConfidence) },
    { key: "inline through", value: `P${policy.minInlinePriority}` },
    { key: "P2 inline confidence", value: String(policy.p2InlineMinConfidence) },
    { key: "max inline", value: String(policy.maxInline) },
  ];
  if (model) rows.push({ key: "model", value: model });
  if (review.thinking) rows.push({ key: "thinking", value: review.thinking });
  if (review.baseRef) rows.push({ key: "base", value: review.baseRef });
  if (review.sha) rows.push({ key: "head", value: review.sha.slice(0, 7) });
  return { recorded: true, rows };
}
