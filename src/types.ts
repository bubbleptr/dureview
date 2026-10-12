/** One pull request head that should be reviewed at most once. */
export type ReviewRequest = {
  owner: string;
  repo: string;
  number: number;
  /** Head commit SHA. */
  sha: string;
  baseSha: string;
  title: string;
  /** HTTPS clone URL of the repository that hosts the pull request, without credentials. */
  cloneUrl: string;
  /** GitHub App installation id, or null when authenticating with a PAT. */
  installationId: number | null;
  draft: boolean;
};

export type Finding = {
  path: string;
  line: number;
  body: string;
};

/** Stable dedupe key: the same pull request head is not reviewed twice. */
export function reviewKey(request: Pick<ReviewRequest, "owner" | "repo" | "number" | "sha">): string {
  return `${request.owner}/${request.repo}#${request.number}@${request.sha}`;
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
