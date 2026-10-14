export type TokenUsage = {
  total: number | null;
  knownReviews: number;
  unknownReviews: number;
};

export type TokenStat = { value: string; detail: string };

/** Card copy for overview token usage. Missing measurements stay unknown; a measured zero stays zero. */
export function overviewTokenStat(usage: TokenUsage | null): TokenStat {
  if (!usage) return { value: "—", detail: "Not recorded on this page" };
  if (usage.total === null) {
    if (usage.unknownReviews === 0) return { value: "—", detail: "No reviews" };
    const count = usage.unknownReviews;
    return { value: "—", detail: count === 1 ? "Unknown for 1 review" : `Unknown for ${count} reviews` };
  }
  if (usage.unknownReviews > 0) {
    return { value: formatTokens(usage.total), detail: `Last 7 days · ${usage.unknownReviews} without usage` };
  }
  return { value: formatTokens(usage.total), detail: "Last 7 days" };
}

/** Empty-state sentence, or null when the trend chart should render. */
export function tokenTrendMessage(usage: TokenUsage | null, hasPoints: boolean): string | null {
  if (usage && usage.total === null && usage.unknownReviews > 0) {
    return "Token totals are unknown for every review in the last 7 days. Older runs were stored before usage was captured, so they are left blank instead of counted as zero.";
  }
  if (!hasPoints) return "No token usage in the last 7 days.";
  return null;
}

export function omittedUsageNote(usage: TokenUsage | null): string | null {
  if (!usage || usage.total === null || usage.unknownReviews <= 0) return null;
  const count = usage.unknownReviews;
  return count === 1
    ? "1 review has no usage and is omitted from the trend."
    : `${count} reviews have no usage and are omitted from the trend.`;
}

function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function trim(value: number): string {
  const digits = Math.abs(value) >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}
