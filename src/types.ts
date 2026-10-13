/** One pull request head that should be reviewed at most once, unless a `/dureview` command asks again. */
export type ReviewRequest = {
  owner: string;
  repo: string;
  number: number;
  /** Head commit SHA. */
  sha: string;
  baseSha: string;
  /**
   * Base branch name. `.dureview.md` is read from this ref, not the pull request head,
   * so the pull request cannot change its own trigger rules.
   */
  baseRef: string;
  title: string;
  /** HTTPS clone URL of the repository that hosts the pull request, without credentials. */
  cloneUrl: string;
  /** GitHub App installation id, or null when authenticating with a PAT. */
  installationId: number | null;
  draft: boolean;
};

/** Repository coordinates used for GitHub API calls that are not yet a full review request. */
export type GitHubRepo = {
  owner: string;
  repo: string;
  installationId: number | null;
};

export type { Finding, FindingCategory, FindingKind, Priority, ReviewSubmission, Verdict } from "./review/schema.js";

/** Stable dedupe key: the same pull request head is not reviewed twice by automatic events. */
export function reviewKey(request: Pick<ReviewRequest, "owner" | "repo" | "number" | "sha">): string {
  return `${request.owner}/${request.repo}#${request.number}@${request.sha}`;
}

/**
 * Command reviews bypass the head SHA key. The same comment is still reviewed once per head SHA.
 */
export function commandReviewKey(
  request: Pick<ReviewRequest, "owner" | "repo" | "number" | "sha">,
  commentId: number,
): string {
  return `${reviewKey(request)}!comment:${commentId}`;
}

/** One automatic review per pull request when `trigger` is `once`. */
export function pullOnceKey(request: Pick<ReviewRequest, "owner" | "repo" | "number">): string {
  return `${request.owner}/${request.repo}#${request.number}`;
}

export function summaryMarker(request: Pick<ReviewRequest, "owner" | "repo" | "number">): string {
  return `<!-- dureview:summary ${request.owner}/${request.repo}#${request.number} -->`;
}

export function taskMarker(taskId: string): string {
  return `<!-- dureview:task ${taskId} -->`;
}

export function inlineMarker(taskId: string): string {
  return `<!-- dureview:inline ${taskId} -->`;
}
