import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm } from "../components/login-form.js";
import { ReviewDetailView } from "../components/review-detail.js";
import { ReviewListView } from "../components/review-list.js";
import type { ReviewDetailModel } from "./detail-model.js";
import type { ReviewListModel } from "./list-model.js";
import { preloadReviewPresentation } from "./review-preload.js";

export function renderLoginHtml(input: { next: string; error?: string }): string {
  return documentShell("登录 · dureview", renderToStaticMarkup(<LoginForm next={input.next} error={input.error} />));
}

export function renderListHtml(model: ReviewListModel): string {
  return documentShell("dureview", renderToStaticMarkup(<ReviewListView model={model} />));
}

export async function renderDetailHtml(model: ReviewDetailModel): Promise<string> {
  const presentation = await preloadReviewPresentation(model);
  return documentShell(
    model.pageTitle,
    renderToStaticMarkup(<ReviewDetailView model={model} presentation={presentation} />),
  );
}

function documentShell(title: string, body: string): string {
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeTitle(title)}</title></head><body>${body}</body></html>`;
  // React 19 prints the DOM property name. The pages and tests use the HTML attribute.
  return html.replaceAll(" dateTime=", " datetime=");
}

function escapeTitle(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
