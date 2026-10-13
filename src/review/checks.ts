import { githubStatus, type CheckRun, type GitHub } from "../github/client.js";
import { log } from "../log.js";
import type { ReviewRequest } from "../types.js";
import { classifyFindings, ReviewConfigError, type ReviewLanguage, type ReviewPolicy } from "./policy.js";
import type { Finding, Priority } from "./schema.js";

/** Check run name. Branch protection can require this exact name. */
export const REVIEW_CHECK_NAME = "dureview";

/** Linked from an `action_required` check. Points at the `.dureview.md` section of the README. */
export const REVIEW_CONFIG_DOCS_URL = "https://github.com/bubbleptr/dureview/blob/main/README.md#dureviewmd";

/** How many times a check update is tried before the task is left retryable as failed. */
const UPDATE_ATTEMPTS = 3;

export type ReviewCheckOutput = {
  conclusion: "success" | "failure" | "action_required" | "neutral" | "cancelled";
  title: string;
  summary: string;
  /** Set for `action_required`, so the check links to the configuration docs. */
  detailsUrl?: string;
};

export type BegunCheck =
  | { status: "open"; id: number; created: boolean }
  | { status: "skipped" }
  | { status: "retry" };

/**
 * The Checks API rejected an update for a reason other than a missing permission.
 * The review task must not complete while its check is still in progress.
 */
export class CheckUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckUpdateError";
  }
}

/**
 * What the check reports for one finished review.
 *
 * Counts findings the review stands behind: past the confidence floor and not on an
 * ignored path. P0 or P1 fails the check. Only P2 and P3 succeed as suggestions.
 * When `summary` is off, findings that were not posted inline are listed so a
 * failing check is not a bare red mark with an empty conversation.
 */
export function reviewCheckOutcome(input: {
  findings: readonly Finding[];
  diff: string;
  policy: ReviewPolicy;
}): ReviewCheckOutput {
  const language = input.policy.language === "zh" ? "zh" : "en";
  const classified = classifyFindings({ findings: [...input.findings], diff: input.diff, policy: input.policy });
  const counts = countFindings(classified.open);
  const blocking = counts[0] + counts[1];
  const suggestions = counts[2] + counts[3];
  const summary = withUnposted(countSummary(counts, language), unpostedLines(classified, input.policy, language), language);
  if (blocking === 0 && suggestions === 0) {
    return {
      conclusion: "success",
      title: language === "zh" ? "未发现问题" : "No findings",
      summary: unpostedLines(classified, input.policy, language).length === 0
        ? language === "zh"
          ? "没有需要处理的问题。"
          : "No issues to report."
        : summary,
    };
  }
  if (blocking > 0) {
    return {
      conclusion: "failure",
      title: language === "zh" ? "有阻断性问题" : "Blocking findings",
      summary,
    };
  }
  return {
    conclusion: "success",
    title: suggestionTitle(suggestions, language),
    summary,
  };
}

/**
 * A review that did not finish. Timeouts, model failures, and other exceptions
 * fail the check. `ReviewConfigError` (a bad `.dureview.md`, an unknown model)
 * is `action_required` and links to the configuration docs.
 */
export function reviewCheckError(error: unknown, language: ReviewLanguage): ReviewCheckOutput {
  const message = error instanceof Error ? error.message : String(error);
  const summary = message.trim().slice(0, 6_000) || (language === "zh" ? "审查失败。" : "The review failed.");
  if (error instanceof ReviewConfigError) {
    return {
      conclusion: "action_required",
      title: language === "zh" ? "需要处理" : "Action required",
      summary,
      detailsUrl: REVIEW_CONFIG_DOCS_URL,
    };
  }
  return {
    conclusion: "failure",
    title: language === "zh" ? "审查失败" : "Review failed",
    summary,
  };
}

export function reviewCheckCancelled(language: ReviewLanguage): ReviewCheckOutput {
  if (language === "zh") {
    return { conclusion: "cancelled", title: "审查已取消", summary: "审查任务已取消。" };
  }
  return { conclusion: "cancelled", title: "Review cancelled", summary: "The review task was cancelled." };
}

/**
 * Open the `dureview` check for this task, or reuse the one already created for the
 * same task id. Returns `skipped` only when the App cannot write checks (403).
 * A transient failure returns `retry` and does not record a permanent skip.
 * Aborts throw. Other in-progress runs on this SHA are completed so they do not spin.
 */
export async function beginReviewCheck(
  github: GitHub,
  request: ReviewRequest,
  taskId: string,
  language: ReviewLanguage,
  signal: AbortSignal,
): Promise<BegunCheck> {
  let runs: CheckRun[];
  try {
    runs = await github.listCheckRuns(request, request.sha, REVIEW_CHECK_NAME, signal);
  } catch (error) {
    throwIfAborted(signal, error);
    if (githubStatus(error) === 403) return skipChecks(request, error);
    reportCheckError(request, error, "list");
    return { status: "retry" };
  }
  try {
    await closeOtherCheckRuns(github, request, runs, taskId, undefined, language, signal);
  } catch (error) {
    throwIfAborted(signal, error);
    if (githubStatus(error) === 403) return skipChecks(request, error);
    reportCheckError(request, error, "update");
    const mine = runs.find((run) => run.externalId === taskId);
    if (mine) return { status: "open", id: mine.id, created: false };
    return { status: "retry" };
  }
  const existing = runs.find((run) => run.externalId === taskId);
  if (existing) return { status: "open", id: existing.id, created: false };
  try {
    const created = await github.createCheckRun(
      request,
      { name: REVIEW_CHECK_NAME, sha: request.sha, externalId: taskId },
      signal,
    );
    return { status: "open", id: created.id, created: true };
  } catch (error) {
    throwIfAborted(signal, error);
    if (githubStatus(error) === 403) return skipChecks(request, error);
    reportCheckError(request, error, "create");
    return { status: "retry" };
  }
}

/**
 * Complete this task's check. A 403 is logged and ignored. Any other update failure
 * is retried, then thrown so the task does not complete while the check is in progress.
 * `settleSiblings` completes other in-progress `dureview` runs on the same SHA.
 */
export async function finishReviewCheck(
  github: GitHub,
  request: ReviewRequest,
  checkRunId: number | null,
  output: ReviewCheckOutput,
  signal: AbortSignal,
  siblings?: { taskId: string; language: ReviewLanguage },
): Promise<void> {
  if (checkRunId === null && !siblings) return;
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    try {
      if (siblings) {
        const runs = await github.listCheckRuns(request, request.sha, REVIEW_CHECK_NAME, signal);
        await closeOtherCheckRuns(github, request, runs, siblings.taskId, checkRunId, siblings.language, signal);
      }
      if (checkRunId === null) return;
      await github.updateCheckRun(
        request,
        checkRunId,
        {
          conclusion: output.conclusion,
          title: output.title,
          summary: output.summary,
          ...(output.detailsUrl ? { detailsUrl: output.detailsUrl } : {}),
        },
        signal,
      );
      return;
    } catch (error) {
      throwIfAborted(signal, error);
      if (githubStatus(error) === 403) {
        skipChecks(request, error);
        return;
      }
      lastError = error;
      reportCheckError(request, error, "update");
      if (attempt < UPDATE_ATTEMPTS) await pause(signal, 20 * attempt);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "update failed");
  throw new CheckUpdateError(detail);
}

/** This task's check id, from the checkpoint or from `external_id` after a crash. */
export async function findOwnCheckRun(
  github: GitHub,
  request: ReviewRequest,
  taskId: string,
  storedId: number | null,
  signal: AbortSignal,
): Promise<number | null> {
  if (storedId !== null) return storedId;
  try {
    const runs = await github.listCheckRuns(request, request.sha, REVIEW_CHECK_NAME, signal);
    return runs.find((run) => run.externalId === taskId)?.id ?? null;
  } catch (error) {
    throwIfAborted(signal, error);
    if (githubStatus(error) === 403) {
      skipChecks(request, error);
      return null;
    }
    reportCheckError(request, error, "list");
    return null;
  }
}

async function closeOtherCheckRuns(
  github: GitHub,
  request: ReviewRequest,
  runs: readonly CheckRun[],
  taskId: string,
  ownId: number | null | undefined,
  language: ReviewLanguage,
  signal: AbortSignal,
): Promise<void> {
  const output = supersededOutput(language);
  for (const run of runs) {
    if (run.status === "completed") continue;
    if (run.externalId === taskId) continue;
    if (ownId !== undefined && ownId !== null && run.id === ownId) continue;
    await github.updateCheckRun(
      request,
      run.id,
      { conclusion: output.conclusion, title: output.title, summary: output.summary },
      signal,
    );
  }
}

function supersededOutput(language: ReviewLanguage): ReviewCheckOutput {
  if (language === "zh") {
    return {
      conclusion: "neutral",
      title: "已被后续审查取代",
      summary: "同一次提交上有更新的 dureview 审查，这个检查已结束。",
    };
  }
  return {
    conclusion: "neutral",
    title: "Superseded",
    summary: "A later dureview run replaced this check.",
  };
}

function suggestionTitle(count: number, language: ReviewLanguage): string {
  if (language === "zh") return `有 ${count} 条建议`;
  return count === 1 ? "1 suggestion" : `${count} suggestions`;
}

function countSummary(counts: Record<Priority, number>, language: ReviewLanguage): string {
  const colon = language === "zh" ? "：" : ": ";
  return ([0, 1, 2, 3] as const).map((priority) => `P${priority}${colon}${counts[priority]}`).join("\n");
}

function countFindings(findings: readonly Finding[]): Record<Priority, number> {
  const counts: Record<Priority, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const finding of findings) counts[finding.priority] += 1;
  return counts;
}

function unpostedLines(
  classified: ReturnType<typeof classifyFindings>,
  policy: ReviewPolicy,
  language: ReviewLanguage,
): string[] {
  if (policy.summary) return [];
  const inline = new Set(classified.inline.map((item) => item.finding.fingerprint));
  const reason = new Map<string, string>();
  const outside = language === "zh" ? "不在 diff 中" : "outside the diff";
  const capped = language === "zh" ? "超过行内上限" : "over the inline cap";
  const folded = language === "zh" ? "未发到行内" : "not inline";
  for (const finding of classified.outOfRange) reason.set(finding.fingerprint, outside);
  for (const finding of classified.overflow) reason.set(finding.fingerprint, capped);
  for (const finding of classified.folded) reason.set(finding.fingerprint, folded);
  return classified.open
    .filter((finding) => !inline.has(finding.fingerprint))
    .map((finding) => `- P${finding.priority} ${finding.path} ${finding.title} (${reason.get(finding.fingerprint) ?? folded})`);
}

function withUnposted(counts: string, lines: readonly string[], language: ReviewLanguage): string {
  if (lines.length === 0) return counts;
  const heading = language === "zh" ? "未发到行内评论：" : "Not posted inline:";
  return `${counts}\n\n${heading}\n${lines.join("\n")}`.slice(0, 6_000);
}

function skipChecks(request: ReviewRequest, error: unknown): { status: "skipped" } {
  log("warn", "GitHub App cannot write check runs; skipping", {
    repo: `${request.owner}/${request.repo}`,
    pr: request.number,
    error: error instanceof Error ? error.message : String(error),
  });
  return { status: "skipped" };
}

function reportCheckError(request: ReviewRequest, error: unknown, action: "list" | "create" | "update"): void {
  log("error", `Could not ${action} the dureview check run`, {
    repo: `${request.owner}/${request.repo}`,
    pr: request.number,
    error: error instanceof Error ? error.message : String(error),
  });
}

function throwIfAborted(signal: AbortSignal, error?: unknown): void {
  if (!signal.aborted) return;
  if (error instanceof Error) throw error;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("aborted");
}

function pause(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });
}
