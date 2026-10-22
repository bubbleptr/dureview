import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffStyleProvider } from "../src/components/diff-style.js";
import { ReviewDetailPending } from "../src/components/review-detail.js";
import type { ReviewDetail, StoredComment } from "../src/review/archive.js";
import { diffStyleCookie, diffStyleFromCookieHeader, resolveDiffStyle } from "../src/ui/diff-style-pref.js";
import { buildReviewDetail } from "../src/ui/detail-data.js";
import type { ReviewDetailHeader } from "../src/ui/detail-model.js";
import { I18nProvider } from "../src/ui/i18n.js";
import { renderDetailHtml } from "../src/ui/render-react.js";
import { sampleFinding } from "./support.js";

const PATCH = ["@@ -1,3 +1,4 @@", " same", "-old", "+new", "+added", " tail"].join("\n");

describe("diff style cookie", () => {
  it("reads a saved style and ignores anything else", () => {
    const request = (cookie: string | null) => ({
      headers: {
        get(name: string) {
          return name === "cookie" ? cookie : null;
        },
      },
    });
    expect(resolveDiffStyle(request("dureview-diff-style=split"))).toBe("split");
    expect(resolveDiffStyle(request("dureview-diff-style=unified"))).toBe("unified");
    expect(resolveDiffStyle(request("dureview-diff-style=side"))).toBe("unified");
    expect(resolveDiffStyle(request(null))).toBe("unified");
    expect(diffStyleFromCookieHeader("other=1; dureview-diff-style=split")).toBe("split");
    expect(diffStyleCookie("split")).toContain("dureview-diff-style=split");
    expect(diffStyleCookie("split")).toContain("SameSite=Lax");
    expect(diffStyleCookie("split")).not.toContain("HttpOnly");
  });

  it("renders the saved split layout on the server", async () => {
    const html = await renderDetailHtml(detailModel(), "en", "/ui/reviews/shot1", "split");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("old");
    expect(html).toContain("added");
    expect(html).not.toContain("whitespace-pre-wrap");
    const unified = await renderDetailHtml(detailModel(), "en", "/ui/reviews/shot1", "unified");
    expect(unified).not.toContain("grid-cols-2");
    expect(unified).toContain("old");
  });

  it("draws a skeleton that follows the saved columns", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: "en" },
        createElement(DiffStyleProvider, { style: "split" }, createElement(ReviewDetailPending, { header: header() })),
      ),
    );
    expect(html).toContain("Loading changed files.");
    expect(html).toContain("Loading the diff.");
    expect(html).toContain("Loading the summary.");
    expect(html).toContain("min-[960px]:border-r");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("h-8 rounded-md border");
    expect(html).toContain('class="panel-handle"');
    expect(html).toContain("--tree-width");
    expect(html).toContain("240px");
    expect(html).toContain("320px");
  });
});

function header(): ReviewDetailHeader {
  return {
    pageTitle: "Review",
    backHref: "/ui/reviews",
    pullHref: "https://github.com/acme/demo/pull/7",
    pullLabel: "acme/demo #7",
    heading: "Review",
    resultKind: "blocker",
    resultText: "Blocker",
    triggerLabel: "opened",
    duration: "1m",
    whenIso: "2026-10-13T15:05:00.000Z",
    whenLabel: "Oct 13",
  };
}

function detailModel() {
  return buildReviewDetail({
    review: detail([stored(sampleFinding({ startLine: 2, endLine: 2 }))]),
    files: [
      {
        filename: "src/pay.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: PATCH,
        previousFilename: null,
      },
    ],
    diffUnavailable: false,
    githubApiUrl: "https://api.github.com",
    now: Date.parse("2026-10-13T15:05:00.000Z"),
  });
}

function stored(finding: ReturnType<typeof sampleFinding>, ordinal = 0): StoredComment {
  return {
    ordinal,
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    priority: finding.priority,
    kind: finding.kind,
    findingType: finding.type,
    subtype: finding.subtype,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    trigger: finding.trigger,
    suggestion: finding.suggestion,
    confidence: finding.confidence,
    fingerprint: finding.fingerprint,
    evidence: finding.evidence,
  };
}

function detail(comments: StoredComment[]): ReviewDetail {
  return {
    taskId: "4",
    owner: "acme",
    repo: "demo",
    number: 7,
    title: "Charge positive amounts",
    trigger: "opened",
    startedAt: "2026-10-13T15:04:00.000Z",
    finishedAt: "2026-10-13T15:05:00.000Z",
    outcome: "completed",
    verdict: "block",
    p0: 0,
    p1: 1,
    p2: 0,
    p3: 0,
    findingCount: comments.length,
    countsKnown: true,
    sha: "a".repeat(40),
    baseSha: "b".repeat(40),
    baseRef: "main",
    installationId: 99,
    verdictReason: "Do not merge.",
    overallConfidence: 0.8,
    checked: ["payment capture"],
    provider: "faux",
    model: "faux-1",
    thinking: "off",
    policy: {
      profile: "default",
      trigger: "auto",
      drafts: false,
      language: "en",
      summary: false,
      minConfidence: 0.5,
      minInlinePriority: 2,
      p2InlineMinConfidence: 0.7,
      maxInline: 10,
    },
    comments,
    error: null,
  };
}
