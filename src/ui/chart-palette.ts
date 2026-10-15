const SLOTS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/** Exact chart labels. The same name keeps the same slot on every chart. */
const NAMED: Record<string, number> = {
  P0: 0,
  Bug: 0,
  Block: 0,
  P1: 1,
  Flag: 1,
  "Fix recommended": 1,
  P2: 2,
  Security: 2,
  security: 2,
  P3: 3,
  Unknown: 3,
  unknown: 3,
  Clean: 4,
};

/**
 * Unnamed series (models, categories, failure reasons) hash to a slot so adding
 * or removing another series does not recolor this one.
 */
export function seriesColor(name: string): string {
  const named = NAMED[name];
  const index = named ?? hashIndex(name);
  return SLOTS[index] ?? SLOTS[0];
}

function hashIndex(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % SLOTS.length;
}
