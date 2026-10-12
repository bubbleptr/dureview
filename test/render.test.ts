import { describe, expect, it } from "vitest";
import { disappeared, parseLedger } from "../src/review/ledger.js";
import { classifyFindings, defaultPolicy } from "../src/review/policy.js";
import { renderInlineComment, renderSummary } from "../src/review/render.js";
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
    expect(renderInlineComment(finding)).toBe(`**[P1] 🐛 重试时会重复扣款**  · correctness · 置信度 0.85

\`charge()\` 失败后外层又调用了一次，但 \`idempotencyKey\` 每次都重新生成（见 \`src/pay.ts:88\`），网关会把它当成新请求。
**触发条件**：网关超时但实际已经成功扣款时。

\`\`\`suggestion
const key = req.idempotencyKey ?? randomUUID();
\`\`\`
<sub>dureview · fp:${finding.fingerprint}</sub>`);
  });

  it("uses the security emoji and omits the suggestion fence when there is no patch", () => {
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
    expect(text).toContain("**[P0] 🔒 Trust the client total**  · security · 置信度 0.9 · CWE-20");
    expect(text).toContain("**证据**：`src/pay.ts:3`");
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
    });

    expect(summary.startsWith("## dureview：⛔ 建议阻断\n合并前会重复扣款。（整体置信度 0.8 · head aaaaaaa）")).toBe(true);
    expect(summary).toContain("| P0 | 重复扣款 |");
    expect(summary.indexOf("| P0 |")).toBeLessThan(summary.indexOf("| P2 |"));
    expect(summary).toContain("🔎 待核实（1） / P3（1）");
    expect(summary).toContain("payment capture on the happy path");
    expect(summary).toContain("✔ 上一轮已修复：");
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
    });
    expect(clean).toContain("## dureview：✅ 未发现问题");
    expect(clean).toContain("<summary>已检查</summary>");
    expect(clean).toContain("payment capture on the happy path");
    expect(clean).not.toContain("| 级别 |");
    expect(clean).not.toContain("上一轮已修复");
  });
});
