import type { GitHub } from "./client.js";
import { commentableLines } from "../review/diff.js";
import { inlineMarker, summaryMarker, taskMarker, type Finding, type ReviewRequest } from "../types.js";

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
 */
export async function publishReview(input: {
  github: GitHub;
  request: ReviewRequest;
  taskId: string;
  provider: string;
  modelId: string;
  summary: string;
  findings: Finding[];
  diff: string;
  signal: AbortSignal;
  afterRemoteWrite?: () => Promise<void>;
}): Promise<PublishResult> {
  const summaryTag = summaryMarker(input.request);
  const taskTag = taskMarker(input.taskId);
  const inlineTag = inlineMarker(input.taskId);
  const body = renderSummary({
    request: input.request,
    provider: input.provider,
    modelId: input.modelId,
    summary: input.summary,
    findings: input.findings,
    summaryTag,
    taskTag,
  });

  const comments = await input.github.listIssueComments(input.request, input.signal);
  const already = comments.find((comment) => comment.body.includes(taskTag));
  let summaryCommentId: number;
  let summaryAction: PublishResult["summaryAction"];
  if (already) {
    summaryCommentId = already.id;
    summaryAction = "unchanged";
  } else {
    const existing = comments.find((comment) => comment.body.includes(summaryTag));
    if (existing) {
      const updated = await input.github.updateIssueComment(input.request, existing.id, body, input.signal);
      summaryCommentId = updated.id;
      summaryAction = "updated";
    } else {
      const created = await input.github.createIssueComment(input.request, body, input.signal);
      summaryCommentId = created.id;
      summaryAction = "created";
    }
  }

  const inline = inlineFindings(input.diff, input.findings);
  const reviews = await input.github.listReviews(input.request, input.signal);
  const posted = reviews.find((review) => review.body.includes(inlineTag));
  let reviewId: number | null = posted?.id ?? null;
  let reviewAction: PublishResult["reviewAction"] = posted ? "unchanged" : "skipped";
  if (!posted && inline.length > 0) {
    const created = await input.github.createReview(
      input.request,
      {
        sha: input.request.sha,
        body: `${inlineTag}\n`,
        comments: inline.map((finding) => ({
          path: finding.path,
          line: finding.line,
          body: finding.body,
        })),
      },
      input.signal,
    );
    reviewId = created.id;
    reviewAction = "created";
  }

  if (input.afterRemoteWrite) await input.afterRemoteWrite();
  return { summaryCommentId, summaryAction, reviewId, reviewAction };
}

export function renderSummary(input: {
  request: Pick<ReviewRequest, "owner" | "repo" | "number" | "sha">;
  provider: string;
  modelId: string;
  summary: string;
  findings: Finding[];
  summaryTag: string;
  taskTag: string;
}): string {
  const overview = input.summary.trim() || (input.findings.length === 0 ? "No findings." : "Findings below.");
  const lines = [
    `Reviewed \`${input.request.sha}\` with \`${input.provider}/${input.modelId}\`.`,
    "",
    overview,
  ];
  if (input.findings.length > 0) {
    lines.push("", "### Findings");
    for (const finding of input.findings) {
      lines.push(`- \`${finding.path}:${finding.line}\` — ${oneLine(finding.body)}`);
    }
  }
  lines.push("", input.summaryTag, input.taskTag);
  return lines.join("\n");
}

function inlineFindings(diff: string, findings: Finding[]): Finding[] {
  const lines = commentableLines(diff);
  const accepted: Finding[] = [];
  for (const finding of findings) {
    const path = finding.path.replaceAll("\\", "/").replace(/^\.\//, "");
    const known = lines.get(path);
    if (known?.has(finding.line)) accepted.push({ ...finding, path });
  }
  return accepted;
}

function oneLine(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}
