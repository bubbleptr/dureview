/** Same order pi-ai uses when it clamps a thinking level down to one the model supports. */
const ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Pick `level` when the model supports it, otherwise the nearest supported level. */
export function nearestThinking(levels: readonly string[], level: string): string {
  if (levels.includes(level)) return level;
  const requestedIndex = ORDER.indexOf(level as (typeof ORDER)[number]);
  if (requestedIndex === -1) return levels[0] ?? "off";
  for (let i = requestedIndex; i < ORDER.length; i++) {
    const candidate = ORDER[i];
    if (candidate && levels.includes(candidate)) return candidate;
  }
  for (let i = requestedIndex - 1; i >= 0; i--) {
    const candidate = ORDER[i];
    if (candidate && levels.includes(candidate)) return candidate;
  }
  return levels[0] ?? "off";
}
