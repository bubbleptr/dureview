/** Preferred file-tree width, in pixels. */
export const TREE_LIMIT = { fallback: 240, min: 180, max: 420 } as const;
/** Preferred summary width, in pixels. */
export const SUMMARY_LIMIT = { fallback: 320, min: 240, max: 520 } as const;
/** Diff column keeps at least this much once the desktop grid is active. */
export const MIN_DIFF_WIDTH = 320;
/** Two `0.375rem` drag handles at a 16px root. */
export const PANEL_HANDLE_WIDTH = 6;

export type PanelWidths = { tree: number; summary: number };

/**
 * Keep the diff column at least `MIN_DIFF_WIDTH`.
 * An unknown container (first paint) uses the preferred widths unchanged.
 * Preferred minimums hold until the viewport cannot fit them beside the diff.
 */
export function fitPanelWidths(tree: number, summary: number, containerWidth: number | null): PanelWidths {
  const preferred = {
    tree: clamp(tree, TREE_LIMIT.min, TREE_LIMIT.max),
    summary: clamp(summary, SUMMARY_LIMIT.min, SUMMARY_LIMIT.max),
  };
  const budget = panelBudget(containerWidth);
  if (budget === null || preferred.tree + preferred.summary <= budget) return preferred;
  let nextTree = preferred.tree;
  let nextSummary = preferred.summary;
  let overflow = nextTree + nextSummary - budget;
  const treeSlack = Math.max(0, nextTree - TREE_LIMIT.min);
  const takeTree = Math.min(overflow, treeSlack);
  nextTree -= takeTree;
  overflow -= takeTree;
  const summarySlack = Math.max(0, nextSummary - SUMMARY_LIMIT.min);
  const takeSummary = Math.min(overflow, summarySlack);
  nextSummary -= takeSummary;
  overflow -= takeSummary;
  if (overflow <= 0) return { tree: nextTree, summary: nextSummary };
  const total = nextTree + nextSummary;
  if (total <= overflow) return { tree: 0, summary: 0 };
  nextTree = Math.min(budget, Math.round((nextTree * (total - overflow)) / total));
  nextSummary = budget - nextTree;
  return { tree: nextTree, summary: nextSummary };
}

/** Drag range for one panel after the other panel and the diff have taken their space. */
export function dragLimit(
  otherShown: number,
  containerWidth: number | null,
  min: number,
  max: number,
): { min: number; max: number } {
  const budget = panelBudget(containerWidth);
  if (budget === null) return { min, max };
  const room = Math.max(0, budget - otherShown);
  const cap = Math.min(max, room);
  if (cap >= min) return { min, max: cap };
  return { min: cap, max: cap };
}

function panelBudget(containerWidth: number | null): number | null {
  if (containerWidth === null || containerWidth <= 0) return null;
  return containerWidth - PANEL_HANDLE_WIDTH * 2 - MIN_DIFF_WIDTH;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
