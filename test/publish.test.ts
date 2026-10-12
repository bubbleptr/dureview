import { describe, expect, it } from "vitest";
import { reviewCommentPayload } from "../src/github/client.js";
import { publishReview } from "../src/github/publish.js";
import { inlineMarker, summaryMarker, taskMarker } from "../src/types.js";
import {
  FINDING,
  FIXTURE_DIFF,
  MemoryGitHub,
  POLICY,
  reviewRequest,
  reviewSubmission,
  sampleFinding,
} from "./support.js";

describe("idempotent posting", () => {
  it("creates one summary and one inline review, then does nothing on the same task", async () => {
    const github = new MemoryGitHub();
    const request = reviewRequest();
    const outside = sampleFinding({
      title: "Note a line outside the diff",
      startLine: 99,
      endLine: 99,
      body: "This line is not in the diff.",
      trigger: "A caller reads line 99.",
    });
    const input = {
      github,
      request,
      taskId: "41",
      provider: "openai-codex",
      modelId: "gpt-5.5",
      review: reviewSubmission("charge() reports success without billing.", [FINDING, outside]),
      policy: POLICY,
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
    expect(github.reviews[0]?.comments).toHaveLength(1);
    expect(github.reviews[0]?.comments[0]).toMatchObject({ path: "src/pay.ts", line: 2 });
    expect(github.reviews[0]?.comments[0]?.body).toContain(FINDING.body);
    expect(github.reviews[0]?.comments[0]?.body).toContain(`fp:${FINDING.fingerprint}`);
    expect(github.comments[0]?.body).toContain(summaryMarker(request));
    expect(github.comments[0]?.body).toContain(taskMarker("41"));
    expect(github.comments[0]?.body).toContain("line is not in the diff");
    expect(github.comments[0]?.body).toContain("范围外");
    expect(github.reviews[0]?.body).toContain(inlineMarker("41"));
    expect(github.reviews[0]?.body).toContain(FINDING.fingerprint);
  });

  it("updates the existing summary when a new task reviews the same pull request", async () => {
    const github = new MemoryGitHub();
    const request = reviewRequest();
    await publishReview(base(github, "41", "first"));
    const next = await publishReview(base(github, "42", "second"));

    expect(github.comments).toHaveLength(1);
    expect(next.summaryAction).toBe("updated");
    expect(github.comments[0]?.body).toContain("second");
    expect(github.comments[0]?.body).toContain(taskMarker("42"));
    expect(github.comments[0]?.body).not.toContain(taskMarker("41"));
    expect(github.reviews).toHaveLength(1);
  });

  it("does not repost a fingerprint and marks a disappeared finding as fixed", async () => {
    const github = new MemoryGitHub();
    const kept = FINDING;
    const gone = sampleFinding({
      title: "Retry the capture",
      startLine: 3,
      endLine: 3,
      body: "A retry can capture twice.",
      trigger: "The gateway times out after a successful capture.",
      priority: 0,
      confidence: 0.95,
    });
    await publishReview(base(github, "41", "first", [kept, gone]));
    const next = await publishReview(base(github, "42", "second", [kept]));

    expect(next.reviewAction).toBe("skipped");
    expect(github.reviews).toHaveLength(1);
    expect(github.comments[0]?.body).toContain("✔ 上一轮已修复：");
    expect(github.comments[0]?.body).toContain(gone.title);
    expect(github.comments[0]?.body).toContain(`fp:${gone.fingerprint}`);
    expect(github.comments[0]?.body).not.toContain(`${kept.title}（`);

    const added = sampleFinding({
      title: "Reject a non-finite amount",
      startLine: 3,
      endLine: 3,
      body: "Non-finite amounts reach the gateway.",
      trigger: "charge(NaN) is called.",
      priority: 1,
      confidence: 0.8,
    });
    const third = await publishReview(base(github, "43", "third", [kept, added]));
    expect(third.reviewAction).toBe("created");
    expect(github.reviews).toHaveLength(2);
    expect(github.reviews[1]?.comments).toHaveLength(1);
    expect(github.reviews[1]?.comments[0]?.body).toContain(added.title);
    expect(github.reviews[1]?.comments[0]?.body).not.toContain(kept.title);
    expect(github.comments[0]?.body).not.toContain("上一轮已修复");

    const fourth = await publishReview(base(github, "44", "fourth", [kept, added]));
    expect(fourth.reviewAction).toBe("skipped");
    expect(github.reviews).toHaveLength(2);
    expect(github.comments[0]?.body).not.toContain("上一轮已修复");
  });
});

describe("resume between writes", () => {
  it("creates the summary without a second inline review when the review was already accepted", async () => {
    const github = new MemoryGitHub();
    const request = reviewRequest();
    await github.createReview(request, {
      sha: request.sha,
      body: `${inlineMarker("41")}\n<!-- dureview:fps ${FINDING.fingerprint} -->\n`,
      comments: [{ path: "src/pay.ts", line: 2, body: "already posted" }],
    });
    const first = await publishReview(base(github, "41", "charge() reports success without billing."));
    const second = await publishReview(base(github, "41", "charge() reports success without billing."));

    expect(first.reviewAction).toBe("unchanged");
    expect(first.summaryAction).toBe("created");
    expect(second.summaryAction).toBe("unchanged");
    expect(second.reviewAction).toBe("unchanged");
    expect(github.reviews).toHaveLength(1);
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.body).toContain(taskMarker("41"));
    expect(github.comments[0]?.body).not.toContain("上一轮已修复");
  });
});

describe("review comment payload", () => {
  it("sets start_line only for a multi-line span", () => {
    expect(reviewCommentPayload({ path: "src/pay.ts", line: 2, body: "one" })).toEqual({
      path: "src/pay.ts",
      line: 2,
      side: "RIGHT",
      body: "one",
    });
    expect(reviewCommentPayload({ path: "src/pay.ts", line: 4, startLine: 2, body: "span" })).toMatchObject({
      start_line: 2,
      start_side: "RIGHT",
      line: 4,
      side: "RIGHT",
    });
  });
});

function base(
  github: MemoryGitHub,
  taskId: string,
  reason: string,
  findings = [FINDING],
) {
  return {
    github,
    request: reviewRequest(),
    taskId,
    provider: "openai-codex",
    modelId: "gpt-5.5",
    review: reviewSubmission(reason, findings),
    policy: POLICY,
    diff: FIXTURE_DIFF,
    signal: new AbortController().signal,
  };
}
