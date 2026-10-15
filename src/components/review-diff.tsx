import type { ReactNode } from "react";
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
  const parsed = parseReviewPatch(patch);
  if (!parsed) return fallback;
  return (
    <FileDiff
      fileDiff={parsed}
      options={reviewDiffOptions({ diffStyle, themeType: diffTheme, lines })}
      lineAnnotations={reviewAnnotations({ ...file, lines })}
      disableWorkerPool
      renderAnnotation={(annotation) => renderComment(annotation.metadata)}
    />
  );
}
