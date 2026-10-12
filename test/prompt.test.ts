import { describe, expect, it } from "vitest";
import { ADVERSARIAL_ROLE, buildUserPrompt } from "../src/review/prompt.js";
import { defaultPolicy } from "../src/review/policy.js";
import { reviewRequest } from "./support.js";

describe("review prompt", () => {
  it("keeps the adversarial review limited to issues this change introduces", () => {
    expect(ADVERSARIAL_ROLE).toContain("this pull request introduces");
    expect(ADVERSARIAL_ROLE).toContain("pre-existing bugs");
    expect(ADVERSARIAL_ROLE).toContain("investigate");
    expect(ADVERSARIAL_ROLE).toContain("concrete trigger");
    expect(ADVERSARIAL_ROLE).toContain("Do not inflate priority");
    expect(ADVERSARIAL_ROLE).toContain("style, naming, formatting");
    expect(ADVERSARIAL_ROLE).toMatch(/evidence/);
    expect(ADVERSARIAL_ROLE).toContain("verdict clean");
  });

  it("tells the model the repository filter without including front matter", () => {
    const prompt = buildUserPrompt({
      request: reviewRequest(),
      diff: "",
      truncated: false,
      rules: "Flag missing error handling.",
      policy: { ...defaultPolicy(), profile: "quiet", maxInline: 4, minInlinePriority: 1 },
    });
    expect(prompt).toContain("Flag missing error handling.");
    expect(prompt).toContain("profile quiet");
    expect(prompt).toContain("at most 4 inline comments");
    expect(prompt).not.toContain("min_inline_priority");
  });
});