import { preloadFileTree } from "@pierre/trees/ssr";
import type { DetailFileView } from "./detail-model.js";
import { reviewTreeOptions, type ReviewTreePreload } from "./review-presentation.js";

/** File tree markup for the first paint. Highlighting waits until a file is open and near the viewport. */
export function reviewTreePreload(files: readonly DetailFileView[]): ReviewTreePreload | null {
  if (files.length === 0) return null;
  const tree = preloadFileTree(reviewTreeOptions([...files]));
  return { id: tree.id, shadowHtml: tree.shadowHtml };
}
