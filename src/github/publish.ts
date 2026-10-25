import type { GitHub, PullReview, ReviewEvent } from "./client.js";
import { isRequestChangesRejected } from "./client.js";
import { log } from "../log.js";
import { checkUnpostedFindings } from "../review/checks.js";
import {
  disappeared,
  inlineFingerprintMarker,
  parseCleanMarker,
  parseLedger,
  postedFingerprints,
  readInlineLedger,
  reviewIdPostedByTask,
  type InlineLedgerEntry,
} from "../review/ledger.js";
import { postingsFromClassified, type FindingPosting } from "../review/findings.js";
import { classifyFindings, type ReviewLanguage, type ReviewPolicy } from "../review/policy.js";
import { renderCleanReview, renderFixedReply, renderInlineDrafts, renderSummary } from "../review/render.js";
import { isInformational, type Finding, type ReviewSubmission } from "../review/schema.js";
import { inlineMarker, reviewKey, summaryMarker, taskMarker, type ReviewRequest } from "../types.js";

export type PublishResult = {
  summaryCommentId: number | null;
  summaryAction: "created" | "updated" | "unchanged" | "skipped";
  reviewId: number | null;
  reviewAction: "created" | "unchanged" | "skipped";
  /** How each finding was posted. Kept so the archive can record ones that were not inlined. */
  postings: FindingPosting[];
};

/**
 * Post the review.
 *
 * Not replay-safe: a crash can happen after GitHub accepts a write and before
 * the task records success. Callers re-enter this function on resume.
 *
 * `summary: true` keeps the summary comment. It lists comments and reviews first
 * and skips any write whose hidden marker is already present. Inline comments are
 * posted before the summary, so a crash between the two writes leaves the previous
 * summary ledger intact.
 *
 * `summary: false` (the default) posts one inline comment per finding and no summary.
 * Each comment carries a fingerprint and task id. A later run reads those comments
 * to dedupe, and resolves the thread when a finding is gone. A crash after any
 * single finding is accepted does not post that finding again. When this run
 * inlines nothing and no earlier inline comment is still open, it submits one
 * Comment review for that head. The hidden clean marker keeps a retry from posting it twice.
 * Overlapping publishes of the same head share one in-process lock.
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
  if (input.policy.summary === true) return publishWithSummary(input);
  return publishWithoutSummary(input);
}

async function publishWithSummary(input: {
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
  const language = languageOf(input.policy);

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
        event: "COMMENT",
        comments: renderInlineDrafts(classified.inline, language),
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
    language,
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
  return {
    summaryCommentId,
    summaryAction,
    reviewId,
    reviewAction,
    postings: postingsFromClassified(classified, input.policy),
  };
}

async function publishWithoutSummary(input: {
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
  const language = languageOf(input.policy);
  const comments = await input.github.listReviewComments(input.request, input.signal);
  const ledger = readInlineLedger(comments);
  const openLedger = ledger.filter((entry) => !entry.handled);
  const alreadyInlined = new Set(openLedger.map((entry) => entry.fingerprint));
  const recoveredByThisTask = new Set(
    openLedger.filter((entry) => entry.taskId === input.taskId).map((entry) => entry.fingerprint),
  );
  const classified = classifyFindings({
    findings: input.review.findings,
    diff: input.diff,
    policy: input.policy,
    alreadyInlined,
  });
  const open = new Set(classified.open.map((finding) => finding.fingerprint));
  const stale = ledger.filter((entry) => !entry.handled && !open.has(entry.fingerprint));
  const postings = postingsFromClassified(classified, input.policy);

  let reviewId: number | null = null;
  let reviewAction: PublishResult["reviewAction"] = "skipped";
  if (classified.inline.length > 0) {
    const event = reviewEvent(classified.inline.map((item) => item.finding));
    const created = await submitReview(
      input.github,
      input.request,
      {
        sha: input.request.sha,
        body: "",
        event,
        comments: renderInlineDrafts(classified.inline, language, input.taskId),
      },
      input.signal,
    );
    reviewId = created.id;
    reviewAction = "created";
  } else {
    const prior = reviewIdPostedByTask(comments, input.taskId);
    const inlineStillOpen = openLedger.some((entry) => open.has(entry.fingerprint));
    if (prior !== undefined) {
      reviewId = prior;
      reviewAction = "unchanged";
    } else if (!inlineStillOpen) {
      const clean = await ensureCleanReview({
        github: input.github,
        request: input.request,
        taskId: input.taskId,
        signal: input.signal,
        language,
        unposted: checkUnpostedFindings(classified, input.policy).length,
      });
      reviewId = clean.id;
      reviewAction = clean.action;
    }
  }

  for (const entry of stale) {
    await markFixed(input, entry, language);
  }

  if (input.afterRemoteWrite) await input.afterRemoteWrite();
  return {
    summaryCommentId: null,
    summaryAction: "skipped",
    reviewId,
    reviewAction,
    postings: postings.map((posting) =>
      recoveredByThisTask.has(posting.fingerprint)
        ? { fingerprint: posting.fingerprint, posted: true, skipReason: null }
        : posting,
    ),
  };
}

// The marker check is too late when two publishes of this head are both past it.
const cleanReviewGate = new Map<string, Promise<void>>();

function withCleanReviewLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = cleanReviewGate.get(key) ?? Promise.resolve();
  const result = previous.then(run);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  cleanReviewGate.set(key, settled);
  void settled.then(() => {
    if (cleanReviewGate.get(key) === settled) cleanReviewGate.delete(key);
  });
  return result;
}

async function ensureCleanReview(input: {
  github: GitHub;
  request: ReviewRequest;
  taskId: string;
  signal: AbortSignal;
  language: ReviewLanguage;
  unposted: number;
}): Promise<{ id: number; action: "created" | "unchanged" }> {
  return withCleanReviewLock(reviewKey(input.request), async () => {
    const reviews = await input.github.listReviews(input.request, input.signal);
    const existing = reviews.find((review) => parseCleanMarker(review.body)?.sha === input.request.sha);
    if (existing) return { id: existing.id, action: "unchanged" };
    const created = await input.github.createReview(
      input.request,
      {
        sha: input.request.sha,
        body: renderCleanReview({
          language: input.language,
          sha: input.request.sha,
          taskId: input.taskId,
          unposted: input.unposted,
        }),
        event: "COMMENT",
        comments: [],
      },
      input.signal,
    );
    return { id: created.id, action: "created" };
  });
}

function reviewEvent(findings: readonly Finding[]): ReviewEvent {
  return findings.some((finding) => !isInformational(finding) && (finding.priority === 0 || finding.priority === 1))
    ? "REQUEST_CHANGES"
    : "COMMENT";
}

async function submitReview(
  github: GitHub,
  request: ReviewRequest,
  review: { sha: string; body: string; event: ReviewEvent; comments: Parameters<GitHub["createReview"]>[1]["comments"] },
  signal: AbortSignal,
): Promise<PullReview> {
  try {
    return await github.createReview(request, review, signal);
  } catch (error) {
    if (review.event !== "REQUEST_CHANGES" || !isRequestChangesRejected(error)) throw error;
    log("warn", "GitHub rejected REQUEST_CHANGES on the author's own pull request; submitting COMMENT", {
      repo: `${request.owner}/${request.repo}`,
      pr: request.number,
    });
    return github.createReview(request, { ...review, event: "COMMENT" }, signal);
  }
}

async function markFixed(
  input: {
    github: GitHub;
    request: ReviewRequest;
    signal: AbortSignal;
  },
  entry: InlineLedgerEntry,
  language: ReviewLanguage,
): Promise<void> {
  const reply = renderFixedReply(language, input.request.sha, entry.fingerprint);
  if (!entry.threadId) {
    log("warn", "Review thread id is missing; replying that the finding is fixed", {
      repo: `${input.request.owner}/${input.request.repo}`,
      pr: input.request.number,
      fingerprint: entry.fingerprint,
    });
    await input.github.replyToReviewComment(input.request, entry.commentId, reply, input.signal);
    return;
  }
  try {
    await input.github.resolveReviewThread(input.request, entry.threadId, input.signal);
  } catch (error) {
    if (isAlreadyResolved(error)) return;
    log("warn", "Could not resolve review thread; replying that the finding is fixed", {
      repo: `${input.request.owner}/${input.request.repo}`,
      pr: input.request.number,
      fingerprint: entry.fingerprint,
      error: error instanceof Error ? error.message : String(error),
    });
    await input.github.replyToReviewComment(input.request, entry.commentId, reply, input.signal);
  }
}

function isAlreadyResolved(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : "";
  return text.includes("already resolved");
}

function languageOf(policy: ReviewPolicy): ReviewLanguage {
  return policy.language === "zh" ? "zh" : "en";
}
