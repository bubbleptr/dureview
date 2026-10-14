import { describe, expect, it } from "vitest";
import { reviewUsageFromLedger } from "../src/review/usage.js";

describe("model usage ledger", () => {
  it("sums reported counters and leaves omitted ones unknown", () => {
    const usage = reviewUsageFromLedger(
      {
        "openai-codex/gpt-5.5": {
          input: 100,
          output: 40,
          cacheRead: 25,
          totalTokens: 165,
          cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
        },
        "openai-codex/gpt-5.4": {
          input: 10,
          output: 5,
          cacheRead: 0,
          reasoning: 4,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      3,
    );
    expect(usage).toEqual({
      inputTokens: 110,
      outputTokens: 45,
      cacheReadTokens: 25,
      reasoningTokens: 4,
      modelCalls: 3,
      costUsd: 0.003,
    });
  });

  it("does not invent reasoning or cost when the provider omitted them", () => {
    const usage = reviewUsageFromLedger(
      {
        "faux/faux-1": {
          input: 8,
          output: 2,
          cacheRead: 0,
          totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      1,
    );
    expect(usage.reasoningTokens).toBeNull();
    expect(usage.costUsd).toBe(0);
    expect(usage.cacheReadTokens).toBe(0);
  });

  it("records a looked-up conversation with no model calls as zeros, not as missing fields", () => {
    expect(reviewUsageFromLedger(undefined, 0)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: null,
      reasoningTokens: null,
      modelCalls: 0,
      costUsd: null,
    });
    expect(reviewUsageFromLedger({}, 0).costUsd).toBeNull();
  });
});
