import { useCallback, useMemo, useRef, type ReactNode } from "react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { DetailCommentView, DetailFileView, DetailLineView } from "../ui/detail-model.js";
import { parseReviewPatch, reviewAnnotations, reviewDiffOptions } from "../ui/review-presentation.js";

export function HighlightedPatch({
  file,
  lines,
  patch,
  diffStyle,
  diffTheme,
  renderComment,
  fallback,
}: {
  file: DetailFileView;
  lines: DetailLineView[];
  patch: string;
  diffStyle: "unified" | "split";
  diffTheme: "light" | "dark";
  renderComment: (comment: DetailCommentView) => ReactNode;
  fallback: ReactNode;
}): ReactNode {
  const lineKey = lineAnnotationKey(lines);
  const stableLines = useMemo(() => lines, [lineKey]);
  const parsed = useMemo(() => parseReviewPatch(patch), [patch]);
  const options = useMemo(
    () => reviewDiffOptions({ diffStyle, themeType: diffTheme, lines: stableLines }),
    // Token colors follow `data-theme` through light-dark(). A new themeType makes FileDiff rebuild the highlighted DOM.
    [diffStyle, stableLines],
  );
  const lineAnnotations = useMemo(() => reviewAnnotations({ ...file, lines: stableLines }), [file, stableLines]);
  const renderCommentRef = useRef(renderComment);
  renderCommentRef.current = renderComment;
  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<DetailCommentView>) => {
    return renderCommentRef.current(annotation.metadata);
  }, []);
  if (!parsed) return fallback;
  return (
    <FileDiff
      fileDiff={parsed}
      options={options}
      lineAnnotations={lineAnnotations}
      disableWorkerPool
      renderAnnotation={renderAnnotation}
    />
  );
}

function lineAnnotationKey(lines: readonly DetailLineView[]): string {
  let key = String(lines.length);
  for (const line of lines) {
    key += "\n";
    key += line.newLabel;
    for (const comment of line.comments) {
      key += "\u0000";
      key += comment.ordinal;
      key += "\u0000";
      key += comment.priority;
      key += "\u0000";
      key += comment.startLine;
      key += "\u0000";
      key += comment.endLine;
      key += "\u0000";
      key += comment.title;
      key += "\u0000";
      key += comment.body;
      key += "\u0000";
      key += comment.suggestion ?? "";
    }
  }
  return key;
}
