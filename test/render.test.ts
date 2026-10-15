import { describe, expect, it } from "vitest";
import { reviewCheckOutcome } from "../src/review/checks.js";
import { disappeared, parseLedger, readInlineLedger } from "../src/review/ledger.js";
import { classifyFindings, defaultPolicy } from "../src/review/policy.js";
import { findingMarker } from "../src/review/ledger.js";
import { renderFixedReply, renderInlineComment, renderInlineDrafts, renderSummary } from "../src/review/render.js";

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
import { FIXTURE_DIFF, reviewRequest, reviewSubmission, sampleFinding } from "./support.js";

describe("comment rendering", () => {
  it("renders an inline comment with a GitHub suggestion", () => {
    const finding = sampleFinding({
      title: "重试时会重复扣款",
      priority: 1,
      kind: "bug",
      category: "correctness",
      confidence: 0.85,
      path: "src/pay.ts",
      startLine: 2,
      endLine: 2,
      body: "`charge()` 失败后外层又调用了一次，但 `idempotencyKey` 每次都重新生成（见 `src/pay.ts:88`），网关会把它当成新请求。",
      trigger: "网关超时但实际已经成功扣款时。",
      suggestion: "const key = req.idempotencyKey ?? randomUUID();",
      evidence: [],
    });
    expect(renderInlineComment(finding, true, "zh")).toBe(`**P1 · 缺陷 · 严重** · 置信度 高 · **重试时会重复扣款** · correctness

\`charge()\` 失败后外层又调用了一次，但 \`idempotencyKey\` 每次都重新生成（见 \`src/pay.ts:88\`），网关会把它当成新请求。
**触发条件**：网关超时但实际已经成功扣款时。

\`\`\`suggestion
const key = req.idempotencyKey ?? randomUUID();
\`\`\`
<sub>dureview · fp:${finding.fingerprint}</sub>`);
  });

  it("uses the security label and omits the suggestion fence when there is no patch", () => {
    const finding = sampleFinding({
      title: "Trust the client total",
      kind: "security",
      priority: 0,
      category: "security",
      cwe: "CWE-20",
      suggestion: null,
      evidence: ["src/pay.ts:3"],
      ruleRef: "payments",
    });
    const text = renderInlineComment(finding);
    expect(text).toContain("**P0 · Security · Critical · CWE-20** · confidence high · **Trust the client total** · security");
    expect(text).not.toMatch(EMOJI);
    expect(text).toContain("**Evidence**: `src/pay.ts:3`");
    expect(text).toContain(`<sub>dureview · fp:${finding.fingerprint} · payments</sub>`);
    expect(text).not.toContain("```suggestion");
  });

  it("renders a blocking summary, a clean summary, and a fixed ledger", () => {
    const request = reviewRequest();
    const p0 = sampleFinding({ title: "重复扣款", priority: 0, confidence: 0.95, startLine: 2, endLine: 2 });
    const p2 = sampleFinding({ title: "边界未处理", priority: 2, confidence: 0.8, startLine: 3, endLine: 3 });
    const folded = sampleFinding({
      title: "也许重复",
      kind: "investigate",
      priority: 1,
      confidence: 0.6,
      startLine: 4,
      endLine: 4,
    });
    const p3 = sampleFinding({ title: "命名待议", priority: 3, confidence: 0.9, startLine: 5, endLine: 5 });
    const review = reviewSubmission("合并前会重复扣款。", [p0, p2, folded, p3], "block");
    const classified = classifyFindings({ findings: review.findings, diff: FIXTURE_DIFF, policy: defaultPolicy() });
    const fixed = disappeared(
      [{ fp: "abc123abc123", title: "旧问题", path: "src/old.ts", start: 4, end: 4, priority: 1, kind: "bug" }],
      classified.open,
    );
    const summary = renderSummary({
      request,
      provider: "openai-codex",
      modelId: "gpt-5.5",
      review,
      classified,
      fixed,
      summaryTag: "<!-- dureview:summary acme/demo#7 -->",
      taskTag: "<!-- dureview:task 41 -->",
      maxInline: 10,
      language: "zh",
    });

    expect(summary.startsWith("## dureview：建议阻断\n合并前会重复扣款。（整体置信度 0.8 · head aaaaaaa）")).toBe(true);
    expect(summary).toContain("| P0 · 缺陷 · 严重 | 重复扣款 |");
    expect(summary.indexOf("| P0 ·")).toBeLessThan(summary.indexOf("| P2 ·"));
    expect(summary).toContain("待核实（1） / P3（1）");
    expect(summary).toContain("payment capture on the happy path");
    expect(summary).toContain("上一轮已修复：");
    expect(summary).not.toMatch(EMOJI);
    expect(summary).toContain("旧问题（src/old.ts:4 · fp:abc123abc123）");
    expect(summary).toContain("<sub>openai-codex/gpt-5.5</sub>");
    expect(parseLedger(summary).map((entry) => entry.title)).toEqual(["重复扣款", "边界未处理", "也许重复", "命名待议"]);

    const clean = renderSummary({
      request,
      provider: "openai-codex",
      modelId: "gpt-5.5",
      review: reviewSubmission("未发现本次改动引入的问题。", [], "clean"),
      classified: classifyFindings({ findings: [], diff: FIXTURE_DIFF, policy: defaultPolicy() }),
      fixed: [],
      summaryTag: "<!-- tag -->",
      taskTag: "<!-- task -->",
      maxInline: 10,
      language: "zh",
    });
    expect(clean).toContain("## dureview：未发现问题");
    expect(clean).toContain("<summary>已检查</summary>");
    expect(clean).toContain("payment capture on the happy path");
    expect(clean).not.toContain("| 级别 |");
    expect(clean).not.toContain("上一轮已修复");
  });

  it("renders English labels, verdicts, and the fixed reply by default", () => {
    const finding = sampleFinding({
      title: "Retry charges twice",
      body: "A retry generates a new idempotency key.",
      trigger: "The gateway times out after a successful capture.",
      suggestion: null,
    });
    const inline = renderInlineComment(finding);
    expect(inline).toContain("**P1 · Bug · Severe** · confidence high · **Retry charges twice** · correctness");
    expect(inline).not.toMatch(EMOJI);
    expect(inline).toContain("**Trigger**: The gateway times out after a successful capture.");
    expect(inline).not.toContain("置信度");
    expect(inline).not.toContain("触发条件");

    const request = reviewRequest();
    const review = reviewSubmission("Stop the merge.", [finding], "block");
    const summary = renderSummary({
      request,
      provider: "openai-codex",
      modelId: "gpt-5.5",
      review,
      classified: classifyFindings({ findings: review.findings, diff: FIXTURE_DIFF, policy: defaultPolicy() }),
      fixed: [{ fp: "abc123abc123", title: "Old bug", path: "src/old.ts", start: 4, end: 4, priority: 1, kind: "bug" }],
      summaryTag: "<!-- tag -->",
      taskTag: "<!-- task -->",
      maxInline: 10,
    });
    expect(summary.startsWith("## dureview: Block\nStop the merge. (overall confidence 0.8 · head aaaaaaa)")).toBe(true);
    expect(summary).toContain("| Severity | Finding | Location |");
    expect(summary).toContain("Fixed since the last review:");
    expect(summary).toContain("- Old bug (src/old.ts:4 · fp:abc123abc123)");
    expect(summary).not.toContain("建议阻断");

    const clean = renderSummary({
      request,
      provider: "openai-codex",
      modelId: "gpt-5.5",
      review: reviewSubmission("Nothing in this push.", [], "clean"),
      classified: classifyFindings({ findings: [], diff: FIXTURE_DIFF, policy: defaultPolicy() }),
      fixed: [],
      summaryTag: "<!-- tag -->",
      taskTag: "<!-- task -->",
      maxInline: 10,
    });
    expect(clean).toContain("## dureview: Nothing to report");
    expect(clean).not.toMatch(EMOJI);
    expect(clean).toContain("<summary>Checked</summary>");

    expect(renderFixedReply("en", "abc1234", finding.fingerprint)).toBe(
      `fixed in abc1234\n<!-- dureview:fixed ${finding.fingerprint} abc1234 -->`,
    );
    expect(renderFixedReply("zh", "abc1234", finding.fingerprint)).toBe(
      `已在 abc1234 修复\n<!-- dureview:fixed ${finding.fingerprint} abc1234 -->`,
    );

    const drafts = renderInlineDrafts(
      classifyFindings({ findings: [finding], diff: FIXTURE_DIFF, policy: defaultPolicy() }).inline,
      "en",
      "41",
    );
    expect(drafts[0]?.body.endsWith(findingMarker(finding.fingerprint, "41"))).toBe(true);

    const check = reviewCheckOutcome({ findings: [finding], diff: FIXTURE_DIFF, policy: defaultPolicy() });
    expect(check.title).not.toMatch(EMOJI);
    expect(check.summary).not.toMatch(EMOJI);
  });

  it("still parses fingerprints from comments that used the old emoji header", () => {
    const finding = sampleFinding();
    const legacy = `**P1 · Bug (severe)** 🐛 **Retry charges twice**  · correctness · confidence 0.9\n\nA retry generates a new key.\n<sub>dureview · fp:${finding.fingerprint}</sub>`;
    const fixed = `fixed in abc1234\n<!-- dureview:fixed ${finding.fingerprint} abc1234 -->`;
    expect(readInlineLedger([{ id: 9, body: legacy, threadId: "t1", inReplyToId: null, resolved: false }])).toEqual([
      expect.objectContaining({ fingerprint: finding.fingerprint, commentId: 9, handled: false }),
    ]);
    expect(
      readInlineLedger([
        { id: 9, body: legacy, threadId: "t1", inReplyToId: null, resolved: false },
        { id: 10, body: fixed, threadId: "t1", inReplyToId: 9, resolved: false },
      ])[0]?.handled,
    ).toBe(true);

    const current = renderSummary({
      request: reviewRequest(),
      provider: "openai-codex",
      modelId: "gpt-5.5",
      review: reviewSubmission("Stop the merge.", [finding], "block"),
      classified: classifyFindings({ findings: [finding], diff: FIXTURE_DIFF, policy: defaultPolicy() }),
      fixed: [],
      summaryTag: "<!-- tag -->",
      taskTag: "<!-- task -->",
      maxInline: 10,
    });
    const withEmoji = current.replace("## dureview: Block", "## dureview: ⛔ Block");
    expect(parseLedger(withEmoji).map((entry) => entry.fp)).toEqual(parseLedger(current).map((entry) => entry.fp));
  });
});
