import { preloadPatchDiff } from "@pierre/diffs/ssr";
import { preloadFileTree } from "@pierre/trees/ssr";
import {
  commentAnchorIndexes,
  focusSegments,
  sliceLines,
  windowDiffText,
} from "./diff-focus.js";
import type { DetailFileView } from "./detail-model.js";
import type { ReviewDetailModel } from "./detail-model.js";
import {
  parseReviewPatch,
  reviewAnnotations,
  reviewDiffOptions,
  reviewTreeOptions,
  type ReviewPresentation,
} from "./review-presentation.js";

/** Highlighted unified diffs and the file tree, for the first server render. */
export async function preloadReviewPresentation(model: ReviewDetailModel): Promise<ReviewPresentation> {
  const jobs: Array<Promise<readonly [string, string] | null>> = [];
  for (const file of model.files) {
    const anchors = commentAnchorIndexes(file.lines);
    if (anchors.length === 0 && file.diffText && parseReviewPatch(file.diffText)) {
      jobs.push(preloadWindow(file, file.diffText, `${file.anchor}:full`, file.lines));
    }
    for (const segment of focusSegments(file.lines, anchors, new Set())) {
      if (segment.kind !== "shown" || anchors.length === 0) continue;
      const lines = sliceLines(file.lines, segment.start, segment.end);
      const patch = windowDiffText(file, lines);
      if (!patch || !parseReviewPatch(patch)) continue;
      jobs.push(preloadWindow(file, patch, `${file.anchor}:${segment.start}-${segment.end}`, lines));
    }
  }
  const entries = await Promise.all(jobs);
  const diffs: Record<string, string> = {};
  for (const entry of entries) {
    if (entry) diffs[entry[0]] = entry[1];
  }
  if (model.files.length === 0) return { diffs, tree: null };
  const tree = preloadFileTree(reviewTreeOptions(model.files));
  return { diffs, tree: { id: tree.id, shadowHtml: tree.shadowHtml } };
}

async function preloadWindow(
  file: DetailFileView,
  patch: string,
  key: string,
  lines: DetailFileView["lines"],
): Promise<readonly [string, string]> {
  const preloaded = await preloadPatchDiff({
    patch,
    options: reviewDiffOptions({ diffStyle: "unified", themeType: "light", lines }),
    annotations: reviewAnnotations({ ...file, lines }),
  });
  return [key, preloaded.prerenderedHTML];
}
