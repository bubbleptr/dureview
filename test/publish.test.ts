import { describe, expect, it } from "vitest";
import { publishReview } from "../src/github/publish.js";
import { inlineMarker, summaryMarker, taskMarker } from "../src/types.js";
import { FINDING, FIXTURE_DIFF, MemoryGitHub, reviewRequest } from "./support.js";

describe("idempotent posting", () => {
  it("creates one summary and one inline review, then does nothing on the same task", async () => {
    const github = new MemoryGitHub();
    const request = reviewRequest();
    const input = {
      github,
      request,
      taskId: "41",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      summary: "charge() reports success without billing.",
      findings: [FINDING, { path: "src/pay.ts", line: 99, body: "This line is not in the diff." }],
      diff: FIXTURE_DIFF,
      signal: new AbortController().signal,
    };
    const first = await publishReview(input);
    const second = await publishReview(input);

    expect(github.comments).toHaveLength(1);
    expect(github.reviews).toHaveLength(1);
    expect(first.summaryAction).toBe("created");
    expect(second.summaryAction).toBe("unchanged");
    expect(second.summaryCommentId).toBe(first.summaryCommentId);
    expect(first.reviewAction).toBe("created");
    expect(second.reviewAction).toBe("unchanged");
    expect(github.reviews[0]?.comments).toEqual([
      { path: "src/pay.ts", line: 2, body: FINDING.body },
    ]);
    expect(github.comments[0]?.body).toContain(summaryMarker(request));
    expect(github.comments[0]?.body).toContain(taskMarker("41"));
    expect(github.comments[0]?.body).toContain("line is not in the diff");
    expect(github.reviews[0]?.body).toContain(inlineMarker("41"));
  });

  it("updates the existing summary when a new task reviews the same pull request", async () => {
    const github = new MemoryGitHub();
    const request = reviewRequest();
    await publishReview({
      github,
      request,
      taskId: "41",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      summary: "first",
      findings: [FINDING],
      diff: FIXTURE_DIFF,
      signal: new AbortController().signal,
    });
    const next = await publishReview({
      github,
      request,
      taskId: "42",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      summary: "second",
      findings: [FINDING],
      diff: FIXTURE_DIFF,
      signal: new AbortController().signal,
    });

    expect(github.comments).toHaveLength(1);
    expect(next.summaryAction).toBe("updated");
    expect(github.comments[0]?.body).toContain("second");
    expect(github.comments[0]?.body).toContain(taskMarker("42"));
    expect(github.comments[0]?.body).not.toContain(taskMarker("41"));
    expect(github.reviews).toHaveLength(2);
  });
});
