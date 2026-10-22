import {
  canUseWASM,
  DEFAULT_THEMES,
  getFiletypeFromFileName,
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type HighlighterOptions,
  type ThemeTypes,
} from "@pierre/diffs";
import type { FileTreeOptions, GitStatus } from "@pierre/trees";
import type { DetailCommentView, DetailFileView } from "./detail-model.js";
import { findingLineCss, findingRanges } from "./diff-focus.js";

export const REVIEW_DIFF_THEME: ThemeTypes = "light";

const HOST_SCHEME = ":host([data-theme=light]){color-scheme:light}:host([data-theme=dark]){color-scheme:dark}";

/**
 * Safari and Firefox drop `:host-context()`, and the tree host sets
 * `color-scheme: light dark`, so `light-dark()` would follow the OS.
 * The page sets `data-theme` on the host; this later layer maps the chrome
 * onto the page tokens.
 */
export const REVIEW_TREE_CSS = [
  ":host{",
  "--trees-bg-override:var(--background);",
  "--trees-fg-override:var(--foreground);",
  "--trees-fg-muted-override:var(--muted-foreground);",
  "--trees-border-color-override:var(--border);",
  "--trees-bg-muted-override:var(--accent);",
  "--trees-selected-bg-override:var(--accent);",
  "--trees-selected-fg-override:var(--accent-foreground);",
  "--trees-selected-focused-border-color-override:var(--ring);",
  "--trees-search-bg-override:var(--background);",
  "--trees-search-fg-override:var(--foreground);",
  "--trees-input-bg-override:var(--background);",
  "--trees-focus-ring-color-override:var(--ring);",
  "--trees-accent-override:var(--foreground);",
  "--trees-font-family-override:var(--font-mono);",
  "--trees-file-icon-color:var(--muted-foreground);",
  "--trees-file-icon-vermilion:var(--muted-foreground);",
  "--trees-file-icon-cyan:var(--muted-foreground)}",
  HOST_SCHEME,
  "[data-icon-token]{color:var(--muted-foreground)}",
  "[data-file-tree-search-input]{font-family:var(--font-sans)}",
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
  preferredHighlighter: "shiki-js" | "highlights";
} {
  return {
    diffStyle: input.diffStyle,
    themeType: input.themeType,
    unsafeCSS: `${REVIEW_DIFF_SURFACE_CSS}${REVIEW_EXPAND_CSS}${findingLineCss(findingRanges(input.lines))}`,
    disableFileHeader: true,
    preferredHighlighter: reviewPreferredHighlighter(),
  };
}

/** Themes and languages FileDiff will ask for, so the first paint is already highlighted. */
export function reviewHighlighterPreload(filename: string): HighlighterOptions {
  return {
    themes: [DEFAULT_THEMES.dark, DEFAULT_THEMES.light],
    langs: ["text", getFiletypeFromFileName(filename)],
    preferredHighlighter: reviewPreferredHighlighter(),
  };
}

function reviewPreferredHighlighter(): "shiki-js" | "highlights" {
  // Highlights needs WASM SIMD. canUseWASM() is false when the engine or the page CSP cannot compile it.
  return canUseWASM() ? "highlights" : "shiki-js";
}

/** Keep a leftover hunk separator readable if a partial patch still emits one. */
export const REVIEW_EXPAND_CSS =
  "[data-expand-button][data-expand-all-button]{display:flex}[data-expand-index] [data-separator-wrapper][data-separator-multi-button]{grid-template-columns:32px 32px minmax(0,1fr) auto}";

/**
 * The diff host also sets `color-scheme: light dark`. Both branches point at
 * the page tokens, and `data-theme` on the host picks the scheme. `:host-context()`
 * does not exist in Safari or Firefox.
 */
export const REVIEW_DIFF_SURFACE_CSS = [
  ":host{",
  "--diffs-light-bg:var(--background);",
  "--diffs-dark-bg:var(--background);",
  "--diffs-light:var(--foreground);",
  "--diffs-dark:var(--foreground);",
  "--diffs-font-family:var(--font-mono)}",
  HOST_SCHEME,
].join("");

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
