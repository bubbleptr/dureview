import { describe, expect, it } from "vitest";
import { findingFingerprint, parseReviewSubmission } from "../src/review/schema.js";

const valid = {
  verdict: "block",
  verdict_reason: "Retrying a timed-out charge bills the customer twice.",
  overall_confidence: 0.8,
  checked: ["duplicate delivery under retries"],
  findings: [
    {
      title: "Reuse the idempotency key on retry",
      priority: 1,
      kind: "bug",
      category: "correctness",
      path: "src/pay.ts",
      start_line: 2,
      end_line: 3,
      body: "A retry generates a new key, so the gateway treats it as a new charge.",
      trigger: "The gateway times out after a successful capture.",
      evidence: ["src/pay.ts:3"],
      suggestion: "const key = req.idempotencyKey ?? randomUUID();",
      cwe: null,
      rule_ref: null,
      confidence: 0.85,
    },
  ],
};

describe("submit_review schema", () => {
  it("accepts the review document and computes a fingerprint", () => {
    const review = parseReviewSubmission(valid);
    expect(review.verdict).toBe("block");
    expect(review.verdictReason).toBe(valid.verdict_reason);
    expect(review.overallConfidence).toBe(0.8);
    expect(review.checked).toEqual(["duplicate delivery under retries"]);
    expect(review.findings[0]).toMatchObject({
      path: "src/pay.ts",
      startLine: 2,
      endLine: 3,
      priority: 1,
      kind: "bug",
      category: "correctness",
      suggestion: "const key = req.idempotencyKey ?? randomUUID();",
      confidence: 0.85,
    });
    expect(review.findings[0]?.fingerprint).toBe(
      findingFingerprint({
        path: "src/pay.ts",
        category: "correctness",
        title: "Reuse the idempotency key on retry",
      }),
    );
  });

  it("accepts a clean review with no findings and no overall confidence", () => {
    const review = parseReviewSubmission({
      verdict: "clean",
      verdict_reason: "No findings.",
      checked: [],
      findings: [],
    });
    expect(review.verdict).toBe("clean");
    expect(review.overallConfidence).toBeNull();
    expect(review.findings).toEqual([]);
  });

  it("rejects a payload that is missing the verdict or uses the old summary shape", () => {
    expect(() => parseReviewSubmission({ summary: "No findings.", findings: [] })).toThrow(/invalid/i);
    expect(() => parseReviewSubmission({ ...valid, verdict: "approve" })).toThrow(/invalid/i);
  });

  it("rejects an unknown finding field, a bad kind, and a confidence outside 0 to 1", () => {
    const finding = valid.findings[0];
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, note: "extra" }] })).toThrow(/invalid/i);
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, kind: "nit" }] })).toThrow(/invalid/i);
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, confidence: 1.2 }] })).toThrow(/invalid/i);
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, confidence: -0.1 }] })).toThrow(/invalid/i);
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, priority: 4 }] })).toThrow(/invalid/i);
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, priority: 1.5 }] })).toThrow(/invalid/i);
  });

  it("rejects a title over 80 characters, a long verdict reason, and a reversed line range", () => {
    const finding = valid.findings[0];
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, title: "x".repeat(81) }] })).toThrow(/invalid/i);
    expect(() => parseReviewSubmission({ ...valid, verdict_reason: "y".repeat(301) })).toThrow(/invalid/i);
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, start_line: 8, end_line: 2 }] })).toThrow(
      /end_line/,
    );
  });

  it("rejects a path that escapes the repository and more than six checks", () => {
    const finding = valid.findings[0];
    expect(() => parseReviewSubmission({ ...valid, findings: [{ ...finding, path: "../secret.ts" }] })).toThrow(
      /repository/,
    );
    expect(() =>
      parseReviewSubmission({
        ...valid,
        checked: ["a", "b", "c", "d", "e", "f", "g"],
      }),
    ).toThrow(/invalid/i);
  });

  it("keeps a fingerprint stable across title case and whitespace, and changes it with category", () => {
    const left = findingFingerprint({ path: "./src/pay.ts", category: "correctness", title: "Reuse   The Key" });
    const right = findingFingerprint({ path: "src/pay.ts", category: "correctness", title: "reuse the key" });
    const other = findingFingerprint({ path: "src/pay.ts", category: "security", title: "reuse the key" });
    expect(left).toBe(right);
    expect(left).toHaveLength(12);
    expect(other).not.toBe(left);
  });
});
