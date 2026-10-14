import type { PullFile } from "../github/client.js";
import { reviewResult, type ReviewDetail, type StoredComment } from "../review/archive.js";
import type { DureviewService } from "../service.js";
import { fileStatusMark, placeReview, type PlacedLine } from "./diff.js";
import type {
  DetailCommentView,
  DetailCount,
  DetailFileView,
  DetailLineView,
  DetailSettings,
  DetailSummary,
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
import type { ReviewPresentation } from "./review-presentation.js";

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type DetailPayload =
  | { kind: "login"; next: string }
  | { kind: "missing" }
  | { kind: "detail"; model: ReviewDetailModel; presentation: ReviewPresentation };

/**
 * Saved review plus the live pull request diff.
 * Returns null when the task id is unknown. A GitHub failure is still a model,
 * with `diffUnavailable` set, so the saved comments can render.
 */
export async function loadReviewDetail(
  service: DureviewService,
  githubApiUrl: string,
  taskId: string,
  now = Date.now(),
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
  });
}

/** Turn an archive row and the GitHub file list into the detail view model. */
export function buildReviewDetail(input: {
  review: ReviewDetail;
  files: PullFile[];
  diffUnavailable: boolean;
  githubApiUrl: string;
  now?: number;
}): ReviewDetailModel {
  const now = input.now ?? Date.now();
  const review = input.review;
  const kind = reviewResult(review);
  const placed = placeReview(input.files, review.comments);
  const whenIso = review.finishedAt ?? review.startedAt;
  const pullLabel = `${review.owner}/${review.repo} #${review.number}`;
  return {
    pageTitle: pullLabel,
    backHref: "/ui",
    pullHref: pullRequestUrl(input.githubApiUrl, review.owner, review.repo, review.number),
    pullLabel,
    heading: review.title || "Untitled",
    resultKind: kind,
    resultText: resultLabel(kind),
    triggerLabel: displayTrigger(review.trigger),
    duration:
      review.outcome === "running"
        ? runningLabel(review.startedAt, now)
        : formatDuration(reviewDurationMs(review.startedAt, review.finishedAt, now)),
    whenIso,
    whenLabel: formatTime(whenIso),
    diffUnavailable: input.diffUnavailable,
    hiddenFiles: placed.hiddenFiles,
    noChangedFiles: placed.files.length === 0 && !input.diffUnavailable,
    outsideTitle: placed.files.length === 0 && !input.diffUnavailable ? "Comments" : "Other files",
    files: placed.files.map(fileView),
    outside: placed.outside.map(commentView),
    summary: summaryView(review, now),
    settings: settingsView(review),
  };
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
}): DetailFileView {
  return {
    anchor: file.anchor,
    filename: file.filename,
    status: file.status,
    statusMark: fileStatusMark(file.status),
    stats: file.patchMissing ? null : `+${file.additions} −${file.deletions}`,
    patchMissing: file.patchMissing,
    patchTruncated: file.patchTruncated,
    diffText: file.diffText,
    lines: file.lines.map(lineView),
    unanchored: file.unanchored.map(commentView),
  };
}

function lineView(line: PlacedLine): DetailLineView {
  return {
    kind: line.kind,
    oldLabel: line.oldLine === null ? "" : String(line.oldLine),
    newLabel: line.newLine === null ? "" : String(line.newLine),
    mark: line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "context" ? " " : "",
    text: line.text,
    severity: line.severity,
    comments: line.comments.map(commentView),
  };
}

function commentView(comment: StoredComment): DetailCommentView {
  return {
    ordinal: comment.ordinal,
    anchor: `c-${comment.ordinal}`,
    priority: comment.priority,
    tags: commentTags(comment.kind, comment.category),
    confidence: `${Math.round(comment.confidence * 100)}%`,
    title: comment.title,
    body: comment.body,
    trigger: comment.trigger,
    evidence: comment.evidence,
    suggestion: comment.suggestion,
    path: comment.path,
    startLine: comment.startLine,
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

function summaryView(review: ReviewDetail, now: number): DetailSummary {
  const kind = reviewResult(review);
  const resultText = resultLabel(kind);
  if (review.outcome !== "completed") {
    const note =
      review.outcome === "failed" ? review.error || "审查失败，没有记录原因。" : runningLabel(review.startedAt, now);
    return { mode: "incomplete", resultKind: kind, resultText, note };
  }
  const verdict = verdictView(review.verdict);
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

function verdictView(verdict: string | null): { label: string; kind: "pass" | "suggest" | "blocker" } | null {
  if (!verdict) return null;
  if (verdict === "fix_recommended") return { label: "Fix recommended", kind: "suggest" };
  if (verdict === "block") return { label: "Block", kind: "blocker" };
  if (verdict === "clean") return { label: "Clean", kind: "pass" };
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
