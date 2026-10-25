import { describe, expect, it, vi } from "vitest";
import { GithubRest, RequestChangesRejectedError, isRequestChangesRejected, reviewCommentPayload } from "../src/github/client.js";
import { publishReview } from "../src/github/publish.js";
import { reviewCheckOutcome } from "../src/review/checks.js";
import { cleanMarker, findingMarker } from "../src/review/ledger.js";
import { inlineMarker, summaryMarker, taskMarker } from "../src/types.js";
import {
  FINDING,
  FIXTURE_DIFF,
  MemoryGitHub,
  POLICY,
  SHA_A,
  SHA_B,
  reviewRequest,
  reviewSubmission,
  sampleFinding,
  testConfig,
  tempDataDir,
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
      policy: { ...POLICY, summary: true },
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
    expect(github.comments[0]?.body).toContain("Out of range");
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
    expect(github.comments[0]?.body).toContain("Fixed since the last review:");
    expect(github.comments[0]?.body).toContain(gone.title);
    expect(github.comments[0]?.body).toContain(`fp:${gone.fingerprint}`);
    expect(github.comments[0]?.body).not.toContain(`${kept.title} (`);

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
    expect(github.comments[0]?.body).not.toContain("Fixed since the last review");

    const fourth = await publishReview(base(github, "44", "fourth", [kept, added]));
    expect(fourth.reviewAction).toBe("skipped");
    expect(github.reviews).toHaveLength(2);
    expect(github.comments[0]?.body).not.toContain("Fixed since the last review");
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
    expect(github.comments[0]?.body).not.toContain("Fixed since the last review");
  });
});

describe("summary off", () => {
  it("posts one inline comment per finding and no summary", async () => {
    const github = new MemoryGitHub();
    const second = sampleFinding({
      title: "Reject a non-finite amount",
      startLine: 3,
      endLine: 3,
      body: "Non-finite amounts reach the gateway.",
      trigger: "charge(NaN) is called.",
      priority: 2,
      confidence: 0.8,
    });
    const input = base(github, "41", "Two findings.", [FINDING, second], { summary: false });
    const first = await publishReview(input);
    const again = await publishReview(input);

    expect(first.summaryAction).toBe("skipped");
    expect(first.summaryCommentId).toBeNull();
    expect(first.reviewAction).toBe("created");
    expect(again.reviewAction).toBe("unchanged");
    expect(again.reviewId).toBe(first.reviewId);
    expect(github.comments).toHaveLength(0);
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]?.event).toBe("REQUEST_CHANGES");
    expect(github.reviewComments).toHaveLength(2);
    expect(github.reviewComments.map((comment) => comment.body).join("\n")).toContain(findingMarker(FINDING.fingerprint, "41"));
    expect(github.reviewComments.map((comment) => comment.body).join("\n")).toContain(findingMarker(second.fingerprint, "41"));
    expect(github.calls.filter((call) => call === "createIssueComment" || call === "updateIssueComment")).toEqual([]);
    expect(github.calls.filter((call) => call === "listReviews")).toEqual([]);
    expect(github.reviews[0]?.body).toBe("");
  });

  it("posts one COMMENT review when there are no inline findings", async () => {
    const github = new MemoryGitHub();
    const result = await publishReview(base(github, "41", "Nothing to report.", [], { summary: false }));

    expect(result.summaryAction).toBe("skipped");
    expect(result.summaryCommentId).toBeNull();
    expect(result.reviewAction).toBe("created");
    expect(result.reviewId).toBe(github.reviews[0]?.id);
    expect(github.comments).toEqual([]);
    expect(github.reviewComments).toEqual([]);
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]).toMatchObject({
      event: "COMMENT",
      comments: [],
      body: cleanBody("en", "41", SHA_A, 0),
    });
    expect(github.calls).toEqual(["listReviewComments", "listReviews", "createReview"]);
  });

  it("does not post a second clean review for the same head", async () => {
    const github = new MemoryGitHub();
    const input = base(github, "41", "Nothing to report.", [], { summary: false });
    const first = await publishReview(input);
    const retry = await publishReview(input);
    const otherTask = await publishReview(base(github, "42", "Still nothing.", [], { summary: false }));

    expect(first.reviewAction).toBe("created");
    expect(retry.reviewAction).toBe("unchanged");
    expect(retry.reviewId).toBe(first.reviewId);
    expect(otherTask.reviewAction).toBe("unchanged");
    expect(otherTask.reviewId).toBe(first.reviewId);
    expect(github.reviews).toHaveLength(1);
    expect(github.calls.filter((call) => call === "createReview")).toEqual(["createReview"]);
  });

  it("posts one clean review when two publishes of the same head overlap", async () => {
    const github = new MemoryGitHub();
    const [first, second] = await Promise.all([
      publishReview(base(github, "41", "Nothing to report.", [], { summary: false })),
      publishReview(base(github, "42", "Still nothing.", [], { summary: false })),
    ]);

    expect(github.reviews).toHaveLength(1);
    expect(github.calls.filter((call) => call === "createReview")).toEqual(["createReview"]);
    expect([first.reviewAction, second.reviewAction].sort()).toEqual(["created", "unchanged"]);
    expect(first.reviewId).toBe(second.reviewId);
    expect(github.reviews[0]?.event).toBe("COMMENT");
  });

  it("posts the clean review in Chinese", async () => {
    const github = new MemoryGitHub();
    const result = await publishReview(base(github, "41", "没有问题。", [], { summary: false, language: "zh" }));

    expect(result.reviewAction).toBe("created");
    expect(github.reviews[0]).toMatchObject({
      event: "COMMENT",
      comments: [],
      body: cleanBody("zh", "41", SHA_A, 0),
    });
  });

  it("counts findings that were not posted inline", async () => {
    const github = new MemoryGitHub();
    const low = sampleFinding({ title: "Unsure about the charge", confidence: 0.1 });
    const folded = sampleFinding({
      title: "A nit on the early return",
      priority: 3,
      confidence: 0.95,
      startLine: 3,
      endLine: 3,
    });
    const outside = sampleFinding({
      title: "Note a line outside the diff",
      startLine: 99,
      endLine: 99,
      body: "This line is not in the diff.",
      trigger: "A caller reads line 99.",
    });
    const ignored = sampleFinding({ title: "Generated output", path: "dist/app.js", confidence: 0.9 });
    const result = await publishReview(
      base(github, "41", "Held back.", [low, folded, outside, ignored], { summary: false }),
    );

    expect(result.reviewAction).toBe("created");
    expect(github.reviewComments).toEqual([]);
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]).toMatchObject({
      event: "COMMENT",
      comments: [],
      body: cleanBody("en", "41", SHA_A, 2),
    });
  });

  it("does not mention the check when the only finding is below min confidence", async () => {
    const github = new MemoryGitHub();
    const low = sampleFinding({ title: "Unsure about the charge", confidence: 0.1 });
    const input = base(github, "41", "Below the floor.", [low], { summary: false });
    await publishReview(input);

    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]?.body).toBe(cleanBody("en", "41", SHA_A, 0));
    expect(reviewCheckOutcome({ findings: [low], diff: input.diff, policy: input.policy })).toEqual({
      conclusion: "success",
      title: "No findings",
      summary: "No issues to report.",
    });
  });

  it("writes the unposted clause in Chinese", async () => {
    const github = new MemoryGitHub();
    const folded = sampleFinding({
      title: "可以以后再看",
      priority: 3,
      confidence: 0.95,
      startLine: 3,
      endLine: 3,
    });
    await publishReview(base(github, "41", "先记下。", [folded], { summary: false, language: "zh" }));

    expect(github.reviews[0]?.event).toBe("COMMENT");
    expect(github.reviews[0]?.body).toBe(cleanBody("zh", "41", SHA_A, 1));
  });

  it("leaves an older clean review in place when a later head has findings", async () => {
    const github = new MemoryGitHub();
    await publishReview(base(github, "41", "clean", [], { summary: false }, SHA_A));
    const next = await publishReview(base(github, "42", "regressed", [FINDING], { summary: false }, SHA_B));

    expect(next.reviewAction).toBe("created");
    expect(github.reviews).toHaveLength(2);
    expect(github.reviews[0]?.event).toBe("COMMENT");
    expect(github.reviews[0]?.body).toBe(cleanBody("en", "41", SHA_A, 0));
    expect(github.reviews[1]?.event).toBe("REQUEST_CHANGES");
    expect(github.reviews[1]?.body).toBe("");
    expect(github.reviews[1]?.comments).toHaveLength(1);
    expect(github.reviewComments).toHaveLength(1);
  });

  it("posts a clean review for a new head after an older one", async () => {
    const github = new MemoryGitHub();
    await publishReview(base(github, "41", "clean", [], { summary: false }, SHA_A));
    const next = await publishReview(base(github, "42", "clean", [], { summary: false }, SHA_B));

    expect(next.reviewAction).toBe("created");
    expect(github.reviews).toHaveLength(2);
    expect(github.reviews[1]?.body).toBe(cleanBody("en", "42", SHA_B, 0));
    expect(github.reviews[0]?.body).toContain(cleanMarker("41", SHA_A));
  });

  it("does not treat an unrelated review as the clean note", async () => {
    const github = new MemoryGitHub();
    await github.createReview(reviewRequest(), {
      sha: SHA_A,
      body: "LGTM",
      event: "COMMENT",
      comments: [],
    });
    const result = await publishReview(base(github, "41", "Nothing to report.", [], { summary: false }));

    expect(result.reviewAction).toBe("created");
    expect(github.reviews).toHaveLength(2);
    expect(github.reviews[1]?.body).toBe(cleanBody("en", "41", SHA_A, 0));
    expect(github.reviews[1]?.event).toBe("COMMENT");
  });

  it("drops investigate and unprovable findings instead of posting them inline", async () => {
    const github = new MemoryGitHub();
    const investigate = sampleFinding({ title: "Maybe wrong", kind: "investigate", priority: 0, confidence: 0.99 });
    const unprovable = sampleFinding({ title: "No trigger", trigger: "  ", priority: 0, confidence: 0.99 });
    const result = await publishReview(base(github, "41", "Suspicions only.", [investigate, unprovable], { summary: false }));

    expect(result.reviewAction).toBe("created");
    expect(github.reviewComments).toEqual([]);
    expect(github.comments).toEqual([]);
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]?.body).toBe(cleanBody("en", "41", SHA_A, 2));
    expect(github.reviews[0]?.event).toBe("COMMENT");
  });

  it("submits COMMENT for P2 findings and REQUEST_CHANGES when any inline finding is P0 or P1", async () => {
    const github = new MemoryGitHub();
    const p2 = sampleFinding({ title: "Boundary", priority: 2, confidence: 0.8, startLine: 3, endLine: 3 });
    await publishReview(base(github, "41", "Boundary only.", [p2], { summary: false }));
    expect(github.reviews[0]?.event).toBe("COMMENT");

    const p0 = sampleFinding({ title: "Always drops the charge", priority: 0, confidence: 0.95 });
    await publishReview(base(github, "42", "Also a blocker.", [p2, p0], { summary: false }));
    expect(github.reviews[1]?.event).toBe("REQUEST_CHANGES");
    expect(github.reviews[1]?.comments).toHaveLength(1);
    expect(github.reviews[1]?.comments[0]?.body).toContain(p0.title);
    expect(github.reviews[1]?.comments[0]?.body).not.toContain(p2.title);
  });

  it("does not post informational flags or request changes for them unless posting is enabled", async () => {
    const github = new MemoryGitHub();
    const note = sampleFinding({
      title: "The early return is the intended happy path",
      type: "flag",
      subtype: "informational",
      priority: 0,
      confidence: 0.99,
      trigger: "",
    });
    const held = await publishReview(base(github, "41", "A note.", [note], { summary: false }));
    expect(held.reviewAction).toBe("created");
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]?.event).toBe("COMMENT");
    expect(github.reviews[0]?.comments).toEqual([]);
    expect(github.reviews[0]?.body).toBe(cleanBody("en", "41", SHA_A, 0));
    expect(held.postings).toEqual([
      expect.objectContaining({ fingerprint: note.fingerprint, posted: false, skipReason: "informational" }),
    ]);

    const allowed = new MemoryGitHub();
    await publishReview(base(allowed, "42", "A note.", [note], { summary: false, postInformational: true }));
    expect(allowed.reviews).toHaveLength(1);
    expect(allowed.reviews[0]?.event).toBe("COMMENT");
    expect(allowed.reviews[0]?.body).toBe("");
    expect(allowed.reviewComments[0]?.body).toContain("P0 · Flag · Informational");
    expect(allowed.reviewComments[0]?.body).not.toContain("REQUEST_CHANGES");
  });

  it("falls back to COMMENT when GitHub rejects REQUEST_CHANGES on the author's own pull request", async () => {
    const github = new MemoryGitHub();
    github.rejectOwnRequestChanges = true;
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      const result = await publishReview(base(github, "41", "Block.", [FINDING], { summary: false }));
      expect(result.reviewAction).toBe("created");
      expect(github.reviews).toHaveLength(1);
      expect(github.reviews[0]?.event).toBe("COMMENT");
      expect(github.reviewComments).toHaveLength(1);
      expect(github.calls.filter((call) => call === "createReview")).toEqual(["createReview", "createReview"]);
      expect(lines.join("\n")).toContain("REQUEST_CHANGES");
      expect(lines.join("\n")).toContain("submitting COMMENT");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not turn an unrelated review error into a COMMENT retry", async () => {
    const github = new MemoryGitHub();
    github.createError = new Error("GitHub POST /reviews failed (422): path is invalid");
    await expect(publishReview(base(github, "41", "Block.", [FINDING], { summary: false }))).rejects.toThrow(/path is invalid/);
    expect(github.reviews).toHaveLength(0);
    expect(github.calls.filter((call) => call === "createReview")).toEqual(["createReview"]);
  });

  it("dedupes from inline markers and resolves a finding that disappeared", async () => {
    const github = new MemoryGitHub();
    const gone = sampleFinding({
      title: "Retry the capture",
      startLine: 3,
      endLine: 3,
      body: "A retry can capture twice.",
      trigger: "The gateway times out after a successful capture.",
      priority: 0,
      confidence: 0.95,
    });
    await publishReview(base(github, "41", "first", [FINDING, gone], { summary: false }));
    const keptThread = github.reviewComments.find((comment) => comment.body.includes(FINDING.fingerprint))?.threadId;
    const goneThread = github.reviewComments.find((comment) => comment.body.includes(gone.fingerprint))?.threadId;

    const next = await publishReview(base(github, "42", "second", [FINDING], { summary: false }));
    expect(next.reviewAction).toBe("skipped");
    expect(github.reviews).toHaveLength(1);
    expect(github.reviewComments).toHaveLength(2);
    expect(github.reviewComments.find((comment) => comment.threadId === keptThread)?.resolved).toBe(false);
    expect(github.reviewComments.find((comment) => comment.threadId === goneThread)?.resolved).toBe(true);
    expect(github.calls.filter((call) => call === "resolveReviewThread")).toEqual(["resolveReviewThread"]);

    await publishReview(base(github, "43", "third", [FINDING], { summary: false }));
    expect(github.reviews).toHaveLength(1);
    expect(github.calls.filter((call) => call === "resolveReviewThread")).toEqual(["resolveReviewThread"]);
    expect(github.comments).toHaveLength(0);
  });

  it("resolves every prior thread when a later push has no findings", async () => {
    const github = new MemoryGitHub();
    await publishReview(base(github, "41", "first", [FINDING], { summary: false }));
    github.calls = [];
    const next = await publishReview(base(github, "42", "clean", [], { summary: false }));

    expect(next.reviewAction).toBe("created");
    expect(next.reviewId).toBe(github.reviews[1]?.id);
    expect(github.reviews).toHaveLength(2);
    expect(github.reviews[1]?.event).toBe("COMMENT");
    expect(github.reviews[1]?.body).toBe(cleanBody("en", "42", SHA_A, 0));
    expect(github.reviewComments[0]?.resolved).toBe(true);
    expect(github.calls).toEqual(["listReviewComments", "listReviews", "createReview", "resolveReviewThread"]);
  });

  it("replies fixed in <sha> when the inline comment has no thread id", async () => {
    const github = new MemoryGitHub();
    github.reviewComments.push({
      id: 5,
      body: `already posted\n${findingMarker(FINDING.fingerprint, "7")}`,
      path: "src/pay.ts",
      line: 2,
      threadId: null,
      inReplyToId: null,
      reviewId: 4,
      resolved: false,
    });
    await publishReview(base(github, "42", "clean", [], { summary: false }));
    await publishReview(base(github, "43", "still clean", [], { summary: false }));

    expect(github.calls.filter((call) => call === "resolveReviewThread")).toEqual([]);
    const replies = github.reviewComments.filter((comment) => comment.inReplyToId === 5);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body.startsWith(`fixed in ${SHA_A}`)).toBe(true);
  });

  it("replies fixed in <sha> when the review thread cannot be resolved, once", async () => {
    const github = new MemoryGitHub();
    github.failResolve = true;
    await publishReview(base(github, "41", "first", [FINDING], { summary: false }));
    await publishReview(base(github, "42", "clean", [], { summary: false }));
    await publishReview(base(github, "43", "still clean", [], { summary: false }));

    const replies = github.reviewComments.filter((comment) => comment.inReplyToId !== null);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toContain(`fixed in ${SHA_A}`);
    expect(replies[0]?.body).toContain(`<!-- dureview:fixed ${FINDING.fingerprint} ${SHA_A} -->`);
    expect(github.calls.filter((call) => call === "replyToReviewComment")).toEqual(["replyToReviewComment"]);
    expect(github.comments).toHaveLength(0);
  });

  it("dedupes a summary-mode inline comment that only has the visible fingerprint footer", async () => {
    const github = new MemoryGitHub();
    await github.createReview(reviewRequest(), {
      sha: SHA_A,
      body: "",
      event: "COMMENT",
      comments: [
        {
          path: "src/pay.ts",
          line: 2,
          body: `<sub>dureview · fp:${FINDING.fingerprint}</sub>`,
        },
      ],
    });
    const result = await publishReview(base(github, "42", "again", [FINDING], { summary: false }));
    expect(result.reviewAction).toBe("skipped");
    expect(github.reviews).toHaveLength(1);
    expect(github.reviewComments).toHaveLength(1);
  });

  it("does not post a finding twice when a previous run already wrote its marker", async () => {
    const github = new MemoryGitHub();
    await github.createReview(reviewRequest(), {
      sha: SHA_A,
      body: "",
      event: "COMMENT",
      comments: [
        {
          path: "src/pay.ts",
          line: 2,
          body: `already posted\n${findingMarker(FINDING.fingerprint, "41")}`,
        },
      ],
    });
    const added = sampleFinding({
      title: "Reject a non-finite amount",
      startLine: 3,
      endLine: 3,
      body: "Non-finite amounts reach the gateway.",
      trigger: "charge(NaN) is called.",
      priority: 1,
      confidence: 0.8,
    });
    const first = await publishReview(base(github, "41", "resume", [FINDING, added], { summary: false }));
    const second = await publishReview(base(github, "41", "resume", [FINDING, added], { summary: false }));

    expect(first.reviewAction).toBe("created");
    expect(second.reviewAction).toBe("unchanged");
    expect(github.reviews).toHaveLength(2);
    expect(github.reviews[1]?.comments).toHaveLength(1);
    expect(github.reviews[1]?.comments[0]?.body).toContain(findingMarker(added.fingerprint, "41"));
    expect(github.reviews[1]?.comments[0]?.body).not.toContain(FINDING.title);
    expect(github.reviewComments.filter((comment) => comment.body.includes(FINDING.fingerprint))).toHaveLength(1);
    expect(github.reviewComments.filter((comment) => comment.body.includes(added.fingerprint))).toHaveLength(1);
    expect(first.postings.find((posting) => posting.fingerprint === FINDING.fingerprint)).toEqual({
      fingerprint: FINDING.fingerprint,
      posted: true,
      skipReason: null,
    });
    expect(second.postings.find((posting) => posting.fingerprint === FINDING.fingerprint)).toEqual({
      fingerprint: FINDING.fingerprint,
      posted: true,
      skipReason: null,
    });
  });

  it("keeps another task's inline comment unposted for this run", async () => {
    const github = new MemoryGitHub();
    await github.createReview(reviewRequest(), {
      sha: SHA_A,
      body: "",
      event: "COMMENT",
      comments: [
        {
          path: "src/pay.ts",
          line: 2,
          body: `already posted\n${findingMarker(FINDING.fingerprint, "7")}`,
        },
      ],
    });
    const result = await publishReview(base(github, "41", "later", [FINDING], { summary: false }));
    expect(result.reviewAction).toBe("skipped");
    expect(github.reviews).toHaveLength(1);
    expect(result.postings.find((posting) => posting.fingerprint === FINDING.fingerprint)).toEqual({
      fingerprint: FINDING.fingerprint,
      posted: false,
      skipReason: "already_inlined",
    });
  });
});

describe("request changes rejection", () => {
  it("recognizes GitHub's own-pull-request error", () => {
    const detail =
      'GitHub POST /repos/acme/demo/pulls/7/reviews failed (422): {"message":"Unprocessable Entity","errors":[{"message":"Can not request changes on your own pull request"}]}';
    expect(isRequestChangesRejected(new Error(detail))).toBe(true);
    expect(isRequestChangesRejected(new RequestChangesRejectedError())).toBe(true);
    expect(isRequestChangesRejected(new Error("GitHub POST /reviews failed (422): path is invalid"))).toBe(false);
  });

  it("maps the REST 422 onto RequestChangesRejectedError", async () => {
    const client = new GithubRest(testConfig(await tempDataDir()));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Unprocessable Entity",
          errors: [{ message: "Can not request changes on your own pull request" }],
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      await expect(
        client.createReview(
          reviewRequest(),
          {
            sha: SHA_A,
            body: "",
            event: "REQUEST_CHANGES",
            comments: [{ path: "src/pay.ts", line: 2, body: "x" }],
          },
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(RequestChangesRejectedError);
    } finally {
      fetchMock.mockRestore();
    }
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

function cleanBody(language: "en" | "zh", taskId: string, sha: string, unposted: number): string {
  const short = sha.slice(0, 7);
  const lead =
    language === "zh"
      ? `dureview 审查完成：未发现需要处理的问题（head ${short}）`
      : `dureview review complete: no issues to address (head ${short})`;
  const extra =
    unposted <= 0
      ? ""
      : language === "zh"
        ? `。另有 ${unposted} 条低优先级提示未贴为行内评论，详见 dureview check。`
        : unposted === 1
          ? ". 1 lower-priority note was not posted as an inline comment; see the dureview check."
          : `. ${unposted} lower-priority notes were not posted as inline comments; see the dureview check.`;
  return `${lead}${extra}\n${cleanMarker(taskId, sha)}`;
}

function base(
  github: MemoryGitHub,
  taskId: string,
  reason: string,
  findings = [FINDING],
  policy: Partial<typeof POLICY> = {},
  sha = SHA_A,
) {
  return {
    github,
    request: reviewRequest(sha),
    taskId,
    provider: "openai-codex",
    modelId: "gpt-5.5",
    review: reviewSubmission(reason, findings),
    policy: { ...POLICY, summary: true, ...policy },
    diff: FIXTURE_DIFF,
    signal: new AbortController().signal,
  };
}
