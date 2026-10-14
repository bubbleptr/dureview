import { parsePatchFiles, type DiffLineAnnotation, type FileDiffMetadata, type ThemeTypes } from "@pierre/diffs";
import type { FileTreeOptions, GitStatus } from "@pierre/trees";
import type { DetailCommentView, DetailFileView } from "./detail-model.js";

export const REVIEW_DIFF_THEME: ThemeTypes = "light";

export type ReviewTreePreload = {
  id: string;
  shadowHtml: string;
};

export type ReviewPresentation = {
  diffs: Record<string, string>;
  tree: ReviewTreePreload | null;
};

export function parseReviewPatch(diffText: string): FileDiffMetadata | null {
  try {
    const parsed = parsePatchFiles(diffText, undefined, true);
    if (parsed.length !== 1) return null;
    const file = parsed[0]?.files[0];
    if (!file || file.hunks.length === 0) return null;
    return file;
  } catch {
    return null;
  }
}

/** Head-file comments, one annotation per comment, on the additions side. */
export function reviewAnnotations(file: DetailFileView): DiffLineAnnotation<DetailCommentView>[] {
  const annotations: DiffLineAnnotation<DetailCommentView>[] = [];
  for (const line of file.lines) {
    if (line.comments.length === 0 || line.newLabel === "") continue;
    const lineNumber = Number(line.newLabel);
    if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
    for (const comment of line.comments) annotations.push({ side: "additions", lineNumber, metadata: comment });
  }
  return annotations;
}

export function reviewFindingCount(file: DetailFileView): number {
  const onLines = file.lines.reduce((sum, line) => sum + line.comments.length, 0);
  return onLines + file.unanchored.length;
}

export function reviewTreeOptions(
  files: DetailFileView[],
  onSelectionChange?: (selectedPaths: readonly string[]) => void,
): FileTreeOptions {
  const counts = new Map(files.map((file) => [file.filename, reviewFindingCount(file)]));
  return {
    id: "review-files",
    paths: files.map((file) => file.filename),
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    initialVisibleRowCount: Math.min(80, Math.max(files.length + 8, 8)),
    gitStatus: files.map((file) => ({ path: file.filename, status: treeStatus(file.status) })),
    renderRowDecoration: (context) => {
      if (context.row.kind !== "file") return null;
      const count = counts.get(context.row.path) ?? 0;
      if (count === 0) return null;
      return { text: String(count), title: count === 1 ? "1 finding" : `${count} findings` };
    },
    onSelectionChange,
  };
}

function treeStatus(status: string): GitStatus {
  if (status === "added") return "added";
  if (status === "removed") return "deleted";
  if (status === "renamed") return "renamed";
  return "modified";
}
