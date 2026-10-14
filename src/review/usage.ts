import type { Usage } from "@earendil-works/pi-ai";

/**
 * Model spend for one review.
 * Null means the provider did not report that counter. A stored zero was reported.
 * Reviews written before capture leave every field unset in SQLite, which is not the same as zero.
 */
export type ReviewUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Cache-read tokens. Null when no usage bucket reported `cacheRead`. */
  cacheReadTokens: number | null;
  /** Reasoning tokens, a subset of output when the provider breaks them out. */
  reasoningTokens: number | null;
  modelCalls: number;
  /** pi-ai `usage.cost.total` when present. Null when no response included a cost. */
  costUsd: number | null;
};

type UsageLike = Partial<Pick<Usage, "input" | "output" | "cacheRead" | "reasoning" | "cost">>;

/**
 * Sum pi-durable's per-model usage ledger (`pi.usage` models bucket).
 * `modelCalls` is the number of assistant generations, which the ledger does not count.
 * Tool-result usage is not included.
 */
export function reviewUsageFromLedger(models: object | undefined, modelCalls: number): ReviewUsage {
  const buckets = models ? Object.values(models).filter(isUsageLike) : [];
  let input = 0;
  let output = 0;
  let cache = 0;
  let cacheSeen = false;
  let reasoning = 0;
  let reasoningSeen = false;
  let cost = 0;
  let costSeen = false;
  for (const bucket of buckets) {
    input += nonNegative(bucket.input);
    output += nonNegative(bucket.output);
    if (typeof bucket.cacheRead === "number" && Number.isFinite(bucket.cacheRead)) {
      cache += nonNegative(bucket.cacheRead);
      cacheSeen = true;
    }
    if (typeof bucket.reasoning === "number" && Number.isFinite(bucket.reasoning)) {
      reasoning += nonNegative(bucket.reasoning);
      reasoningSeen = true;
    }
    const total = bucket.cost?.total;
    if (typeof total === "number" && Number.isFinite(total)) {
      cost += total;
      costSeen = true;
    }
  }
  return {
    inputTokens: asCount(input),
    outputTokens: asCount(output),
    cacheReadTokens: cacheSeen ? asCount(cache) : null,
    reasoningTokens: reasoningSeen ? asCount(reasoning) : null,
    modelCalls: asCount(modelCalls),
    costUsd: costSeen ? cost : null,
  };
}

function isUsageLike(value: unknown): value is UsageLike {
  return typeof value === "object" && value !== null;
}

function nonNegative(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

function asCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.round(value), 1_000_000_000_000);
}
