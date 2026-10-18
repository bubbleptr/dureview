/** A posted inline comment's lines, as recorded at the review head. */
export type AdoptionSpan = {
  path: string;
  startLine: number;
  endLine: number;
};

export type AdoptionDiffFile = {
  filename: string;
  previousFilename: string | null;
  status: string;
  patch: string | null;
};

export type AdoptionStatus = "adopted" | "ignored" | "pending" | "unclassified";

/**
 * Decide whether one posted inline comment was adopted.
 *
 * Incidental edits count as adopted: a later diff that touches the finding's
 * lines is adopted even when the author was not responding to the comment.
 * Line numbers are the review head, so an edit above the finding shifts later
 * lines without counting as a touch. A file GitHub changed without a patch
 * (a large diff) stays unclassified: a missing patch is not an untouched file.
 */
export function classifyFindingAdoption(input: {
  pullOpen: boolean;
  reviewSha: string;
  finalHeadSha: string;
  threadResolved: boolean;
  /** GitHub omitted files past the compare cap, so a path that is absent may still have changed. */
  diffCapped?: boolean;
  finding: AdoptionSpan;
  files: readonly AdoptionDiffFile[];
}): AdoptionStatus {
  if (input.pullOpen) return "pending";
  const laterCommits = input.reviewSha !== input.finalHeadSha;
  const touch = linesTouched(input.finding, input.files);
  if (touch === "touched") return "adopted";
  if (input.threadResolved && laterCommits) return "adopted";
  if (touch === "unknown") return "unclassified";
  if (input.diffCapped && !listedFile(input.finding, input.files)) return "unclassified";
  return "ignored";
}

function listedFile(finding: AdoptionSpan, files: readonly AdoptionDiffFile[]): boolean {
  return files.some((file) => file.filename === finding.path || file.previousFilename === finding.path);
}

type ThreadComment = { body: string; resolved: boolean; threadId?: string | null };

/**
 * The archive row's task id is on the comment this review posted.
 * An older resolved thread for the same fingerprint is a different comment.
 */
export function findingThreadResolved(
  finding: { fingerprint: string; taskId: string },
  comments: readonly ThreadComment[],
): boolean {
  if (!/^[0-9a-f]{12}$/.test(finding.fingerprint) || finding.taskId.length === 0) return false;
  const marker = `<!-- dureview:finding ${finding.fingerprint} ${finding.taskId} -->`;
  const posted = comments.find((comment) => comment.body.includes(marker));
  if (posted) return threadResolved(posted, comments);
  const footer = `fp:${finding.fingerprint}`;
  const loose = comments.filter((comment) => comment.body.includes(footer) && !comment.body.includes("dureview:finding "));
  const threadIds = new Set(loose.map((comment, index) => comment.threadId ?? `solo:${index}`));
  const only = loose[0];
  if (!only || threadIds.size !== 1) return false;
  return threadResolved(only, comments);
}

function threadResolved(comment: ThreadComment, comments: readonly ThreadComment[]): boolean {
  if (!comment.threadId) return comment.resolved;
  return comments.some((item) => item.threadId === comment.threadId && item.resolved);
}

export function linesTouched(finding: AdoptionSpan, files: readonly AdoptionDiffFile[]): "touched" | "untouched" | "unknown" {
  const start = Math.min(finding.startLine, finding.endLine);
  const end = Math.max(finding.startLine, finding.endLine);
  let unknown = false;
  for (const file of files) {
    if (file.filename !== finding.path && file.previousFilename !== finding.path) continue;
    const status = file.status.toLowerCase();
    if (status === "removed" || status === "added") return "touched";
    if (file.patch == null) {
      unknown = true;
      continue;
    }
    if (patchTouchesLines(file.patch, start, end)) return "touched";
  }
  return unknown ? "unknown" : "untouched";
}

/**
 * True when a unified diff deletes a line in `[start, end]` or inserts a line
 * directly before one. A deletion followed by an addition replaces that line;
 * the added text does not also count as an insertion before the next line.
 * Context lines, including ones shifted by an earlier hunk, do not count.
 */
export function patchTouchesLines(patch: string, startLine: number, endLine: number): boolean {
  const start = Math.min(startLine, endLine);
  const end = Math.max(startLine, endLine);
  if (start < 1) return false;
  let oldLine = 0;
  let inHunk = false;
  let deleted = 0;
  let added = 0;
  const covers = (line: number) => line >= start && line <= end;
  const flush = (): boolean => {
    const inserted = added - deleted;
    const touches = inserted > 0 && covers(oldLine);
    deleted = 0;
    added = 0;
    return touches;
  };
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk?.[1]) {
      if (inHunk && flush()) return true;
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      oldLine = oldCount === 0 ? oldStart + 1 : oldStart;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      if (added > 0 && flush()) return true;
      if (covers(oldLine)) return true;
      deleted += 1;
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      if (flush()) return true;
      oldLine += 1;
    }
  }
  return inHunk && flush();
}
