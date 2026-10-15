import { parsePatchFiles, type DiffLineAnnotation, type FileDiffMetadata, type ThemeTypes } from "@pierre/diffs";
import type { FileTreeOptions, GitStatus } from "@pierre/trees";
import type { DetailCommentView, DetailFileView } from "./detail-model.js";
import { findingLineCss, findingRanges } from "./diff-focus.js";

export const REVIEW_DIFF_THEME: ThemeTypes = "light";

export const REVIEW_TREE_CSS = [
  "[data-file-tree-search-container]{display:block;padding:12px 12px 8px}",
  "[data-file-tree-search-input]{box-sizing:border-box;width:100%;height:32px;margin:0;border:1px solid var(--border, #e5e5e5);border-radius:6px;background:transparent;color:inherit;padding:0 10px;font:inherit;font-size:13px;outline:none}",
  "[data-file-tree-search-input]:focus{box-shadow:0 0 0 2px var(--ring, #a3a3a3)}",
].join("");

export function reviewDiffOptions(input: {
  diffStyle: "unified" | "split";
  themeType: "light" | "dark";
  lines: DetailFileView["lines"];
}): {
  diffStyle: "unified" | "split";
  themeType: "light" | "dark";
  unsafeCSS: string;
  disableFileHeader: true;
  preferredHighlighter: "shiki-js";
} {
  return {
    diffStyle: input.diffStyle,
    themeType: input.themeType,
    unsafeCSS: `${REVIEW_EXPAND_CSS}${findingLineCss(findingRanges(input.lines))}`,
    disableFileHeader: true,
    // The WASM Oniguruma engine is a separate chunk. The page highlights with Shiki's JavaScript engine.
    preferredHighlighter: "shiki-js",
  };
}

/** Keep a leftover hunk separator readable if a partial patch still emits one. */
export const REVIEW_EXPAND_CSS =
  "[data-expand-button][data-expand-all-button]{display:flex}[data-expand-index] [data-separator-wrapper][data-separator-multi-button]{grid-template-columns:32px 32px minmax(0,1fr) auto}";

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
    return dropUnloadedGaps(file);
  } catch {
    return null;
  }
}

/**
 * A GitHub patch is partial: lines outside its hunks were never loaded.
 * Pierre treats that gap as expandable context and then asks for the full file.
 * The review page owns those gaps, so drop them and keep the hunk line numbers.
 */
function dropUnloadedGaps(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;
  let removed = 0;
  for (const hunk of file.hunks) {
    const gap = hunk.collapsedBefore;
    if (gap <= 0) continue;
    hunk.collapsedBefore = 0;
    hunk.splitLineStart -= removed + gap;
    hunk.unifiedLineStart -= removed + gap;
    removed += gap;
  }
  if (removed > 0) {
    file.splitLineCount -= removed;
    file.unifiedLineCount -= removed;
  }
  return file;
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
    searchBlurBehavior: "retain",
    unsafeCSS: REVIEW_TREE_CSS,
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
