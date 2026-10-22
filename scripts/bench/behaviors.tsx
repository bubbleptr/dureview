import { createRoot } from "react-dom/client";
import { ReviewDetailPending, ReviewDetailView } from "../../src/components/review-detail.js";
import type { ReviewDetailHeader, ReviewDetailModel } from "../../src/ui/detail-model.js";
import { I18nProvider } from "../../src/ui/i18n.js";
import { PageLocationProvider } from "../../src/ui/page-location.js";
import "../../src/styles.css";
import { behaviorFiles } from "./fixtures.js";

const files = behaviorFiles();

const model: ReviewDetailModel = {
  pageTitle: "bench",
  backHref: "/ui/reviews",
  pullHref: "https://github.com/acme/demo/pull/7",
  pullLabel: "acme/demo #7",
  heading: "Bench review",
  resultKind: "blocker",
  resultText: "Blocker",
  triggerLabel: "opened",
  duration: "1m",
  whenIso: "2026-10-13T15:05:00.000Z",
  whenLabel: "Oct 13",
  diffUnavailable: false,
  hiddenFiles: 0,
  noChangedFiles: false,
  outsideTitle: "Outside the diff",
  files,
  outside: [],
  summary: {
    mode: "incomplete",
    resultKind: "blocker",
    resultText: "Blocker",
    note: "Bench fixture.",
  },
  settings: { recorded: false },
};

const header: ReviewDetailHeader = {
  pageTitle: model.pageTitle,
  backHref: model.backHref,
  pullHref: model.pullHref,
  pullLabel: model.pullLabel,
  heading: model.heading,
  resultKind: model.resultKind,
  resultText: model.resultText,
  triggerLabel: model.triggerLabel,
  duration: model.duration,
  whenIso: model.whenIso,
  whenLabel: model.whenLabel,
};

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
const pending = new URLSearchParams(location.search).get("view") === "pending";
createRoot(root).render(
  <PageLocationProvider location="/ui/reviews/bench">
    <I18nProvider locale="en">
      {pending ? <ReviewDetailPending header={header} /> : <ReviewDetailView model={model} />}
    </I18nProvider>
  </PageLocationProvider>,
);
