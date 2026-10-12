import type { GitHub } from "./client.js";
import { disappeared, inlineFingerprintMarker, parseLedger, postedFingerprints } from "../review/ledger.js";
import { classifyFindings, type ReviewPolicy } from "../review/policy.js";
import { renderInlineDrafts, renderSummary } from "../review/render.js";
import type { ReviewSubmission } from "../review/schema.js";
import { inlineMarker, summaryMarker, taskMarker, type ReviewRequest } from "../types.js";

export type PublishResult = {
  summaryCommentId: number;
  summaryAction: "created" | "updated" | "unchanged";
  reviewId: number | null;
  reviewAction: "created" | "unchanged" | "skipped";
};

/**
 * Post the summary comment and inline review.
 *
 * Not replay-safe: a crash can happen after GitHub accepts the write and before
 * the task records success. Callers re-enter this function on resume. It lists
 * comments and reviews first and skips any write whose hidden marker is already
 * present, so the same task never double-posts. A later push uses a new task id,
 * finds the summary by the pull-request marker, and updates that comment.
 *
 * Inline comments are posted before the summary. A crash between the two writes
 * leaves the previous summary ledger intact, so resume computes the same fixed
 * set and skips fingerprints already listed on the review body.
 */
export async function publishReview(input: {
  github: GitHub;
  request: ReviewRequest;
  taskId: string;
  provider: string;
  modelId: string;
  review: ReviewSubmission;
  policy: ReviewPolicy;
  diff: string;
  signal: AbortSignal;
  afterRemoteWrite?: () => Promise<void>;
}): Promise<PublishResult> {
  const summaryTag = summaryMarker(input.request);
  const taskTag = taskMarker(input.taskId);
  const inlineTag = inlineMarker(input.taskId);

  const comments = await input.github.listIssueComments(input.request, input.signal);
  const reviews = await input.github.listReviews(input.request, input.signal);
  const existingSummary = comments.find((comment) => comment.body.includes(summaryTag));
  const previous = parseLedger(existingSummary?.body);
  const alreadyInlined = postedFingerprints(reviews.map((review) => review.body));
  const classified = classifyFindings({
    findings: input.review.findings,
    diff: input.diff,
    policy: input.policy,
    alreadyInlined,
  });
  const fixed = disappeared(previous, classified.open);

  const posted = reviews.find((review) => review.body.includes(inlineTag));
  let reviewId: number | null = posted?.id ?? null;
  let reviewAction: PublishResult["reviewAction"] = posted ? "unchanged" : "skipped";
  if (!posted && classified.inline.length > 0) {
    const fingerprints = classified.inline.map((item) => item.finding.fingerprint);
    const created = await input.github.createReview(
      input.request,
      {
        sha: input.request.sha,
        body: `${inlineTag}\n${inlineFingerprintMarker(fingerprints)}\n`,
        comments: renderInlineDrafts(classified.inline),
      },
      input.signal,
    );
    reviewId = created.id;
    reviewAction = "created";
  }

  const body = renderSummary({
    request: input.request,
    provider: input.provider,
    modelId: input.modelId,
    review: input.review,
    classified,
    fixed,
    summaryTag,
    taskTag,
    maxInline: input.policy.maxInline,
  });
  const already = comments.find((comment) => comment.body.includes(taskTag));
  let summaryCommentId: number;
  let summaryAction: PublishResult["summaryAction"];
  if (already) {
    summaryCommentId = already.id;
    summaryAction = "unchanged";
  } else if (existingSummary) {
    const updated = await input.github.updateIssueComment(input.request, existingSummary.id, body, input.signal);
    summaryCommentId = updated.id;
    summaryAction = "updated";
  } else {
    const created = await input.github.createIssueComment(input.request, body, input.signal);
    summaryCommentId = created.id;
    summaryAction = "created";
  }

  if (input.afterRemoteWrite) await input.afterRemoteWrite();
  return { summaryCommentId, summaryAction, reviewId, reviewAction };
}
