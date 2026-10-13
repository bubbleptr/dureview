import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";

/** Same tool script the Node end-to-end test uses, so the posted finding matches. */
export function scriptedReview(): FauxResponseStep[] {
  return [
    fauxAssistantMessage(fauxToolCall("read", { path: "src/pay.ts" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("grep", { pattern: "capture" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(
      fauxToolCall("submit_review", {
        verdict: "fix_recommended",
        verdict_reason: "charge() reports success without billing.",
        overall_confidence: 0.8,
        checked: ["payment capture on the happy path"],
        findings: [
          {
            title: "Return success without billing",
            priority: 1,
            kind: "bug",
            category: "correctness",
            path: "src/pay.ts",
            start_line: 2,
            end_line: 2,
            body: "Positive amounts return success without capturing the charge, so the customer is never billed.",
            trigger: "charge() is called with a positive amount.",
            evidence: [],
            suggestion: null,
            cwe: null,
            rule_ref: null,
            confidence: 0.9,
          },
        ],
      }),
      { stopReason: "toolUse" },
    ),
  ];
}
