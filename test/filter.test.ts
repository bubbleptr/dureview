import { describe, expect, it } from "vitest";
import { classifyFindings, defaultPolicy, parseDureviewDocument, type ReviewPolicy } from "../src/review/policy.js";
import { FIXTURE_DIFF, sampleFinding } from "./support.js";

function policy(overrides: Partial<ReviewPolicy> = {}): ReviewPolicy {
  return { ...defaultPolicy(), ...overrides };
}

describe("finding filters", () => {
  it("drops confidence below 0.5 and keeps 0.5", () => {
    const low = sampleFinding({ title: "Low", confidence: 0.49, priority: 0 });
    const edge = sampleFinding({ title: "Edge", confidence: 0.5, priority: 0 });
    const result = classifyFindings({ findings: [low, edge], diff: FIXTURE_DIFF, policy: policy() });
    expect(result.dropped.map((item) => item.finding.title)).toEqual(["Low"]);
    expect(result.dropped[0]?.reason).toBe("confidence");
    expect(result.inline.map((item) => item.finding.title)).toEqual(["Edge"]);
  });

  it("folds investigate, empty triggers, P3, and P2 under 0.7", () => {
    const investigate = sampleFinding({ title: "Maybe wrong", kind: "investigate", priority: 1, confidence: 0.95 });
    const noTrigger = sampleFinding({ title: "No trigger", trigger: "  ", priority: 0, confidence: 0.99 });
    const p3 = sampleFinding({ title: "Latent", priority: 3, confidence: 0.99 });
    const soft = sampleFinding({ title: "Soft edge", priority: 2, confidence: 0.69 });
    const firm = sampleFinding({ title: "Firm edge", priority: 2, confidence: 0.7 });
    const result = classifyFindings({
      findings: [investigate, noTrigger, p3, soft, firm],
      diff: FIXTURE_DIFF,
      policy: policy(),
    });
    expect(result.inline.map((item) => item.finding.title)).toEqual(["Firm edge"]);
    expect(result.folded.map((item) => item.title).sort()).toEqual(["Latent", "Maybe wrong", "No trigger", "Soft edge"]);
    expect(result.table.map((item) => item.title)).toEqual(["Firm edge"]);
  });

  it("sorts inline comments by priority then confidence and caps them at max_inline", () => {
    const findings = [
      sampleFinding({ title: "Issue P1", priority: 1, confidence: 0.99 }),
      ...Array.from({ length: 10 }, (_, index) =>
        sampleFinding({
          title: `P0 ${index}`,
          priority: 0 as const,
          confidence: 0.6 + index / 100,
        }),
      ),
    ];
    const result = classifyFindings({
      findings,
      diff: FIXTURE_DIFF,
      policy: policy({ maxInline: 10 }),
    });
    expect(result.inline).toHaveLength(10);
    expect(result.inline.every((item) => item.finding.priority === 0)).toBe(true);
    expect(result.inline[0]?.finding.title).toBe("P0 9");
    expect(result.overflow.map((item) => item.title)).toEqual(["Issue P1"]);
    expect(result.table).toHaveLength(11);
    expect(result.table[0]?.priority).toBe(0);
  });

  it("skips lockfiles, generated files, binaries, and dist, plus a configured glob", () => {
    const lock = sampleFinding({ title: "Lock", path: "package-lock.json" });
    const nested = sampleFinding({ title: "Nested lock", path: "packages/app/pnpm-lock.yaml" });
    const generated = sampleFinding({ title: "Generated", path: "src/api.generated.ts" });
    const minified = sampleFinding({ title: "Min", path: "src/app.min.js" });
    const binary = sampleFinding({ title: "Binary", path: "assets/logo.png" });
    const dist = sampleFinding({ title: "Dist", path: "dist/index.js" });
    const vendor = sampleFinding({ title: "Vendor", path: "vendor/lib.ts" });
    const kept = sampleFinding({ title: "Real" });
    const result = classifyFindings({
      findings: [lock, nested, generated, minified, binary, dist, vendor, kept],
      diff: wideDiff([
        "package-lock.json",
        "packages/app/pnpm-lock.yaml",
        "src/api.generated.ts",
        "src/app.min.js",
        "assets/logo.png",
        "dist/index.js",
        "vendor/lib.ts",
        "src/pay.ts",
      ]),
      policy: policy({ ignore: ["vendor/**"] }),
    });
    expect(result.dropped.map((item) => item.reason)).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "ignored",
    ]);
    expect(result.inline.map((item) => item.finding.title)).toEqual(["Real"]);
  });

  it("can replace the default ignore list", () => {
    const lock = sampleFinding({ title: "Lock", path: "package-lock.json", startLine: 1, endLine: 1 });
    const result = classifyFindings({
      findings: [lock],
      diff: wideDiff(["package-lock.json"]),
      policy: policy({ ignoreDefaults: false, ignore: [] }),
    });
    expect(result.dropped).toEqual([]);
    expect(result.inline).toHaveLength(1);
  });

  it("sends a line outside the diff to the out-of-range section", () => {
    const outside = sampleFinding({ title: "Outside", startLine: 99, endLine: 99 });
    const result = classifyFindings({ findings: [outside], diff: FIXTURE_DIFF, policy: policy() });
    expect(result.inline).toEqual([]);
    expect(result.outOfRange.map((item) => item.title)).toEqual(["Outside"]);
  });

  it("anchors a fully covered range and withholds a suggestion when the range is partial", () => {
    const span = sampleFinding({
      title: "Span",
      startLine: 2,
      endLine: 3,
      suggestion: "return gateway.capture(amount);",
    });
    const partial = sampleFinding({
      title: "Partial",
      startLine: 2,
      endLine: 40,
      suggestion: "nope",
    });
    const result = classifyFindings({ findings: [span, partial], diff: FIXTURE_DIFF, policy: policy() });
    const full = result.inline.find((item) => item.finding.title === "Span");
    const part = result.inline.find((item) => item.finding.title === "Partial");
    expect(full).toMatchObject({ line: 3, startLine: 2, includeSuggestion: true });
    expect(part).toMatchObject({ line: 6, includeSuggestion: false });
    expect(part?.startLine).toBeUndefined();
  });

  it("does not inline a fingerprint that was already posted", () => {
    const finding = sampleFinding();
    const result = classifyFindings({
      findings: [finding],
      diff: FIXTURE_DIFF,
      policy: policy(),
      alreadyInlined: new Set([finding.fingerprint]),
    });
    expect(result.inline).toEqual([]);
    expect(result.table.map((item) => item.fingerprint)).toEqual([finding.fingerprint]);
    expect(result.open).toHaveLength(1);
  });

  it("keeps the higher-confidence copy when two findings share a fingerprint", () => {
    const quiet = sampleFinding({ confidence: 0.6, body: "short" });
    const loud = sampleFinding({ confidence: 0.95, body: "detailed" });
    const result = classifyFindings({ findings: [quiet, loud], diff: FIXTURE_DIFF, policy: policy() });
    expect(result.inline).toHaveLength(1);
    expect(result.inline[0]?.finding.body).toBe("detailed");
  });

  it("applies quiet and loud profiles", () => {
    const p2 = sampleFinding({ title: "Boundary", priority: 2, confidence: 0.55 });
    const quiet = classifyFindings({
      findings: [p2],
      diff: FIXTURE_DIFF,
      policy: parseDureviewDocument("---\nprofile: quiet\n---\n").policy,
    });
    const loud = classifyFindings({
      findings: [p2],
      diff: FIXTURE_DIFF,
      policy: parseDureviewDocument("---\nprofile: loud\n---\n").policy,
    });
    expect(quiet.inline).toEqual([]);
    expect(quiet.folded.map((item) => item.title)).toEqual(["Boundary"]);
    expect(loud.inline.map((item) => item.finding.title)).toEqual(["Boundary"]);
  });
});

describe(".dureview.md config", () => {
  it("reads front matter and leaves the prose as rules", () => {
    const parsed = parseDureviewDocument(`---
profile: quiet
min_confidence: 0.6
min_inline_priority: 2
p2_inline_min_confidence: 0.8
max_inline: 4
ignore:
  - "vendor/**"
  - 'generated/**'
---

# Review rules

Flag missing error handling.
`);
    expect(parsed.rules).toBe("# Review rules\n\nFlag missing error handling.");
    expect(parsed.policy).toEqual({
      profile: "quiet",
      minConfidence: 0.6,
      minInlinePriority: 2,
      p2InlineMinConfidence: 0.8,
      maxInline: 4,
      ignoreDefaults: true,
      ignore: ["vendor/**", "generated/**"],
      language: "en",
      summary: false,
      postInformational: false,
      trigger: "manual",
      drafts: false,
    });
  });

  it("uses defaults when the file has no front matter", () => {
    const parsed = parseDureviewDocument("Flag success returned without calling the payment gateway.\n");
    expect(parsed.rules).toContain("Flag success");
    expect(parsed.policy).toEqual(defaultPolicy());
  });

  it("reads trigger and drafts, and rejects bad values", () => {
    const parsed = parseDureviewDocument("---\ntrigger: once\ndrafts: true\n---\n");
    expect(parsed.policy.trigger).toBe("once");
    expect(parsed.policy.drafts).toBe(true);
    expect(defaultPolicy().trigger).toBe("manual");
    expect(defaultPolicy().drafts).toBe(false);
    expect(parseDureviewDocument("---\nlanguage: zh\n---\n", { trigger: "once" }).policy.trigger).toBe("once");
    expect(parseDureviewDocument("rules only\n", { trigger: "auto" }).policy.trigger).toBe("auto");
    expect(parseDureviewDocument("---\ntrigger: manual\n---\n", { trigger: "auto" }).policy.trigger).toBe("manual");
    expect(defaultPolicy({ trigger: "auto" }).trigger).toBe("auto");
    expect(() => parseDureviewDocument("---\ntrigger: sometimes\n---\n")).toThrow(/trigger/);
    expect(() => parseDureviewDocument("---\ndrafts: yes\n---\n")).toThrow(/drafts/);
  });

  it("rejects an unknown key, a duplicate key, and a bad profile", () => {
    expect(() => parseDureviewDocument("---\nnitpicks: true\n---\n")).toThrow(/Unknown/);
    expect(() => parseDureviewDocument("---\nmax_inline: 1\nmax_inline: 2\n---\n")).toThrow(/Duplicate/);
    expect(() => parseDureviewDocument("---\nprofile: assertive\n---\n")).toThrow(/profile/);
  });

  it("reads language and summary, and rejects bad values", () => {
    const parsed = parseDureviewDocument("---\nlanguage: zh\nsummary: true\n---\nKeep the payment path strict.\n");
    expect(parsed.policy.language).toBe("zh");
    expect(parsed.policy.summary).toBe(true);
    expect(parsed.rules).toContain("payment path");
    expect(defaultPolicy().language).toBe("en");
    expect(defaultPolicy().summary).toBe(false);
    expect(() => parseDureviewDocument("---\nlanguage: fr\n---\n")).toThrow(/language/);
    expect(() => parseDureviewDocument("---\nsummary: yes\n---\n")).toThrow(/summary/);
  });

  it("lets an explicit priority override the quiet profile", () => {
    const parsed = parseDureviewDocument("---\nprofile: quiet\nmin_inline_priority: 0\nignore: []\n---\n");
    expect(parsed.policy.minInlinePriority).toBe(0);
    expect(parsed.policy.profile).toBe("quiet");
    expect(parsed.policy.ignore).toEqual([]);
  });
});

function wideDiff(paths: string[]): string {
  return paths
    .map(
      (file) => `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,3 +1,6 @@
 context
+added
+added
+added
+added
 context
`,
    )
    .join("");
}
