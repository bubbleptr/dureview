import { githubStatus, type GitHub } from "../github/client.js";
import { log } from "../log.js";
import type { ReviewRequest } from "../types.js";
import { classifyFindings, type ReviewLanguage, type ReviewPolicy } from "./policy.js";
import type { Finding, Priority } from "./schema.js";

/** Check run name. Branch protection can require this exact name. */
export const REVIEW_CHECK_NAME = "dureview";

export type ReviewCheckOutput = {
  conclusion: "success" | "failure" | "action_required";
  title: string;
  summary: string;
};

/**
 * What the check reports for one finished review.
 *
 * Counts findings the review stands behind: past the confidence floor and not on an
 * ignored path. That includes P3, investigate, and out-of-range lines. Dropped
 * findings are not findings. P0 or P1 fails the check. Only P2 and P3 succeed as
 * suggestions, so a required check does not block on them.
 */
export function reviewCheckOutcome(input: {
  findings: readonly Finding[];
  diff: string;
  policy: ReviewPolicy;
}): ReviewCheckOutput {
  const language = input.policy.language === "zh" ? "zh" : "en";
  const counts = countOpenFindings(input.findings, input.diff, input.policy);
  const blocking = counts[0] + counts[1];
  const suggestions = counts[2] + counts[3];
  if (blocking === 0 && suggestions === 0) {
    return {
      conclusion: "success",
      title: language === "zh" ? "未发现问题" : "No findings",
      summary: language === "zh" ? "没有需要处理的问题。" : "No issues to report.",
    };
  }
  if (blocking > 0) {
    return {
      conclusion: "failure",
      title: language === "zh" ? "有阻断性问题" : "Blocking findings",
      summary: countSummary(counts, language),
    };
  }
  return {
    conclusion: "success",
    title: suggestionTitle(suggestions, language),
    summary: countSummary(counts, language),
  };
}

/**
 * A review that did not finish. Timeouts, model failures, and other exceptions
 * fail the check. Configuration the operator has to fix (an unknown model, a bad
 * `.dureview.md`) is `action_required`. Either way the check leaves `in_progress`.
 */
export function reviewCheckError(message: string, language: ReviewLanguage): ReviewCheckOutput {
  const action = message.includes(".dureview.md") || message.startsWith("Unknown model ");
  const summary = message.trim().slice(0, 6_000) || (language === "zh" ? "审查失败。" : "The review failed.");
  if (action) {
    return {
      conclusion: "action_required",
      title: language === "zh" ? "需要处理" : "Action required",
      summary,
    };
  }
  return {
    conclusion: "failure",
    title: language === "zh" ? "审查失败" : "Review failed",
    summary,
  };
}

/**
 * Open the `dureview` check for this task, or reuse the one already created for the
 * same task id. Returns null when the App cannot write checks (403) or the API
 * fails. Callers keep reviewing either way.
 */
export async function beginReviewCheck(
  github: GitHub,
  request: ReviewRequest,
  taskId: string,
  signal: AbortSignal,
): Promise<number | null> {
  let runs: Awaited<ReturnType<GitHub["listCheckRuns"]>> | undefined;
  try {
    runs = await github.listCheckRuns(request, request.sha, REVIEW_CHECK_NAME, signal);
  } catch (error) {
    if (githubStatus(error) === 403) {
      return skipChecks(request, error);
    }
    reportCheckError(request, error, "list");
  }
  const existing = runs?.find((run) => run.externalId === taskId);
  if (existing) return existing.id;
  try {
    const created = await github.createCheckRun(
      request,
      { name: REVIEW_CHECK_NAME, sha: request.sha, externalId: taskId },
      signal,
    );
    return created.id;
  } catch (error) {
    if (githubStatus(error) === 403) return skipChecks(request, error);
    reportCheckError(request, error, "create");
    return null;
  }
}

/** Complete the check. A 403 or any other API error is logged and ignored. */
export async function finishReviewCheck(
  github: GitHub,
  request: ReviewRequest,
  checkRunId: number | null,
  output: ReviewCheckOutput,
  signal: AbortSignal,
): Promise<void> {
  if (checkRunId === null) return;
  try {
    await github.updateCheckRun(request, checkRunId, {
      conclusion: output.conclusion,
      title: output.title,
      summary: output.summary,
    }, signal);
  } catch (error) {
    if (githubStatus(error) === 403) {
      skipChecks(request, error);
      return;
    }
    reportCheckError(request, error, "update");
  }
}

function suggestionTitle(count: number, language: ReviewLanguage): string {
  if (language === "zh") return `有 ${count} 条建议`;
  return count === 1 ? "1 suggestion" : `${count} suggestions`;
}

function countSummary(counts: Record<Priority, number>, language: ReviewLanguage): string {
  const colon = language === "zh" ? "：" : ": ";
  return ([0, 1, 2, 3] as const).map((priority) => `P${priority}${colon}${counts[priority]}`).join("\n");
}

function countOpenFindings(
  findings: readonly Finding[],
  diff: string,
  policy: ReviewPolicy,
): Record<Priority, number> {
  const classified = classifyFindings({ findings: [...findings], diff, policy });
  const counts: Record<Priority, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const finding of classified.open) counts[finding.priority] += 1;
  return counts;
}

function skipChecks(request: ReviewRequest, error: unknown): null {
  log("warn", "GitHub App cannot write check runs; skipping", {
    repo: `${request.owner}/${request.repo}`,
    pr: request.number,
    error: error instanceof Error ? error.message : String(error),
  });
  return null;
}

function reportCheckError(request: ReviewRequest, error: unknown, action: "list" | "create" | "update"): void {
  log("error", `Could not ${action} the dureview check run`, {
    repo: `${request.owner}/${request.repo}`,
    pr: request.number,
    error: error instanceof Error ? error.message : String(error),
  });
}
