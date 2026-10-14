import { preloadPatchDiff } from "@pierre/diffs/ssr";
import { preloadFileTree } from "@pierre/trees/ssr";
import type { ReviewDetailModel } from "./detail-model.js";
import {
  REVIEW_DIFF_THEME,
  REVIEW_EXPAND_CSS,
  parseReviewPatch,
  reviewAnnotations,
  reviewTreeOptions,
  type ReviewPresentation,
} from "./review-presentation.js";

/** Highlighted unified diffs and the file tree, for the first server render. */
export async function preloadReviewPresentation(model: ReviewDetailModel): Promise<ReviewPresentation> {
  const entries = await Promise.all(
    model.files.map(async (file) => {
      if (!file.diffText || !parseReviewPatch(file.diffText)) return null;
      const preloaded = await preloadPatchDiff({
        patch: file.diffText,
        options: {
          diffStyle: "unified",
          themeType: REVIEW_DIFF_THEME,
          unsafeCSS: REVIEW_EXPAND_CSS,
          // Presence of a loader is what draws the expand controls. Contents load on click.
          loadDiffFiles: async () => {
            throw new Error("full file contents load when a hunk is expanded");
          },
        },
        annotations: reviewAnnotations(file),
      });
      return [file.anchor, preloaded.prerenderedHTML] as const;
    }),
  );
  const diffs: Record<string, string> = {};
  for (const entry of entries) {
    if (entry) diffs[entry[0]] = entry[1];
  }
  if (model.files.length === 0) return { diffs, tree: null };
  const tree = preloadFileTree(reviewTreeOptions(model.files));
  return { diffs, tree: { id: tree.id, shadowHtml: tree.shadowHtml } };
}
