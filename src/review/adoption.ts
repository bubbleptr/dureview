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

export type AdoptionStatus = "adopted" | "ignored" | "pending";

/**
 * Decide whether one posted inline comment was adopted.
 *
 * Incidental edits count as adopted: a later diff that touches the finding's
 * lines is adopted even when the author was not responding to the comment.
 * Line numbers are the review head (the old side of `reviewSha..finalHead`),
 * so edits above the finding shift later lines without counting as a touch.
 */
export function classifyFindingAdoption(input: {
  pullOpen: boolean;
  reviewSha: string;
  finalHeadSha: string;
  threadResolved: boolean;
  finding: AdoptionSpan;
  files: readonly AdoptionDiffFile[];
}): AdoptionStatus {
  if (input.pullOpen) return "pending";
  const laterCommits = input.reviewSha !== input.finalHeadSha;
  if (linesTouched(input.finding, input.files)) return "adopted";
  if (input.threadResolved && laterCommits) return "adopted";
  return "ignored";
}

export function findingThreadResolved(
  fingerprint: string,
  comments: readonly { body: string; resolved: boolean }[],
): boolean {
  if (!/^[0-9a-f]{12}$/.test(fingerprint)) return false;
  const marker = `dureview:finding ${fingerprint} `;
  const footer = `fp:${fingerprint}`;
  for (const comment of comments) {
    if (!comment.resolved) continue;
    if (comment.body.includes(marker) || comment.body.includes(footer)) return true;
  }
  return false;
}

export function linesTouched(finding: AdoptionSpan, files: readonly AdoptionDiffFile[]): boolean {
  const start = Math.min(finding.startLine, finding.endLine);
  const end = Math.max(finding.startLine, finding.endLine);
  for (const file of files) {
    if (file.filename !== finding.path && file.previousFilename !== finding.path) continue;
    const status = file.status.toLowerCase();
    if (status === "removed" || status === "added") return true;
    if (patchTouchesLines(file.patch, start, end)) return true;
  }
  return false;
}

/**
 * True when a unified diff deletes a line in `[start, end]` or inserts a line
 * directly before one. Context lines, including ones shifted by an earlier hunk,
 * do not count.
 */
export function patchTouchesLines(patch: string | null | undefined, startLine: number, endLine: number): boolean {
  if (!patch) return false;
  const start = Math.min(startLine, endLine);
  const end = Math.max(startLine, endLine);
  if (start < 1) return false;
  let oldLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (hunk?.[1]) {
      const oldStart = Number(hunk[1]);
      const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      oldLine = oldCount === 0 ? oldStart + 1 : oldStart;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      if (oldLine >= start && oldLine <= end) return true;
      continue;
    }
    if (line.startsWith("-")) {
      if (oldLine >= start && oldLine <= end) return true;
      oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) oldLine += 1;
  }
  return false;
}
