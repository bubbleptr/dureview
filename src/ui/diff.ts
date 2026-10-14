import type { PullFile } from "../github/client.js";
import type { StoredComment } from "../review/archive.js";

const MAX_PATCH_CHARS = 200_000;
const MAX_FILES = 200;

export type PatchLine = {
  kind: "hunk" | "add" | "del" | "context";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};

export type PlacedLine = PatchLine & {
  comments: StoredComment[];
  /** Lowest priority covering this new-file line, when one does. */
  severity: number | null;
};

export type PlacedFile = {
  anchor: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  lines: PlacedLine[];
  unanchored: StoredComment[];
  patchMissing: boolean;
  patchTruncated: boolean;
};

export type PlacedReview = {
  files: PlacedFile[];
  /** Comments whose path is not in the file list that was rendered. */
  outside: StoredComment[];
  hiddenFiles: number;
};

/** Parse a GitHub file patch. `+`/`-` prefixes are stripped from `text`. */
export function parsePatch(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk?.[1] && hunk[2]) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", oldLine: null, newLine: null, text: raw });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", oldLine: null, newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ kind: "del", oldLine, newLine: null, text: raw.slice(1) });
      oldLine += 1;
      continue;
    }
    const text = raw.startsWith(" ") ? raw.slice(1) : raw;
    lines.push({ kind: "context", oldLine, newLine, text });
    oldLine += 1;
    newLine += 1;
  }
  return lines;
}

/**
 * Attach structured comments to head-file lines in the live pull request diff.
 * A comment sits on its end line, or on the last visible line of its range.
 */
export function placeReview(files: PullFile[], comments: StoredComment[]): PlacedReview {
  const sorted = [...files].sort((a, b) => a.filename.localeCompare(b.filename));
  const shown = sorted.slice(0, MAX_FILES);
  const hiddenFiles = sorted.length - shown.length;
  const byPath = new Map<string, StoredComment[]>();
  for (const comment of comments) {
    const list = byPath.get(comment.path);
    if (list) list.push(comment);
    else byPath.set(comment.path, [comment]);
  }
  const rendered = new Set<string>();
  const placed: PlacedFile[] = shown.map((file, index) => {
    rendered.add(file.filename);
    const mine = byPath.get(file.filename) ?? [];
    return placeFile(file, mine, `file-${index}`);
  });
  const outside = comments.filter((comment) => !rendered.has(comment.path));
  return { files: placed, outside, hiddenFiles };
}

export function fileStatusMark(status: string): string {
  if (status === "added") return "A";
  if (status === "removed") return "D";
  if (status === "renamed") return "R";
  if (status === "copied") return "C";
  return "M";
}

function placeFile(file: PullFile, comments: StoredComment[], anchor: string): PlacedFile {
  const truncated = file.patch !== null && file.patch.length > MAX_PATCH_CHARS;
  const patch = file.patch === null ? null : file.patch.slice(0, MAX_PATCH_CHARS);
  const parsed = patch === null ? [] : parsePatch(patch);
  const attached = new Set<number>();
  const extra: StoredComment[][] = parsed.map(() => []);
  for (const comment of comments) {
    const index = anchorIndex(parsed, comment);
    if (index === null) continue;
    extra[index]?.push(comment);
    attached.add(comment.ordinal);
  }
  const lines: PlacedLine[] = parsed.map((line, index) => ({
    ...line,
    comments: extra[index] ?? [],
    severity: severityAt(line, comments),
  }));
  return {
    anchor,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    lines,
    unanchored: comments.filter((comment) => !attached.has(comment.ordinal)),
    patchMissing: patch === null,
    patchTruncated: truncated,
  };
}

function anchorIndex(lines: PatchLine[], comment: StoredComment): number | null {
  let last = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.newLine === null) continue;
    if (line.newLine < comment.startLine || line.newLine > comment.endLine) continue;
    last = index;
    if (line.newLine === comment.endLine) return index;
  }
  return last === -1 ? null : last;
}

function severityAt(line: PatchLine, comments: StoredComment[]): number | null {
  if (line.newLine === null) return null;
  let severity: number | null = null;
  for (const comment of comments) {
    if (line.newLine < comment.startLine || line.newLine > comment.endLine) continue;
    if (severity === null || comment.priority < severity) severity = comment.priority;
  }
  return severity;
}
