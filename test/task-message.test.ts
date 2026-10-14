import { describe, expect, it } from "vitest";
import { unfinishedReviewMessage } from "../src/review/task.js";

describe("unfinished review settlement", () => {
  it("keeps a reason that has no detail", () => {
    expect(unfinishedReviewMessage("run", { reason: "timeout" })).toBe("Review run did not finish: timeout");
    expect(unfinishedReviewMessage("nudge", { reason: "aborted" })).toBe("Review nudge did not finish: aborted");
  });

  it("includes the settlement detail for run and nudge", () => {
    const detail = "OAuth auth derivation failed for openai-codex: Cannot find module openai-codex.js";
    expect(unfinishedReviewMessage("run", { reason: "model_error", detail })).toBe(
      `Review run did not finish: model_error: ${detail}`,
    );
    expect(unfinishedReviewMessage("nudge", { reason: "model_error", detail })).toBe(
      `Review nudge did not finish: model_error: ${detail}`,
    );
  });

  it("truncates a long detail to 500 characters", () => {
    const detail = "x".repeat(800);
    const message = unfinishedReviewMessage("run", { reason: "model_error", detail });
    const included = message.slice("Review run did not finish: model_error: ".length);
    expect(included).toHaveLength(500);
    expect(included).toBe("x".repeat(500));
    expect(message).not.toContain("x".repeat(501));
  });

  it("stringifies a structured detail", () => {
    expect(unfinishedReviewMessage("nudge", { reason: "faulted", detail: { code: "model_error" } })).toBe(
      'Review nudge did not finish: faulted: {"code":"model_error"}',
    );
  });
});
