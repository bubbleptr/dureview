import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm } from "../components/login-form.js";
import { ReviewDetailView } from "../components/review-detail.js";
import { ReviewListView } from "../components/review-list.js";
import { SettingsForm } from "../components/settings-form.js";
import { OverviewPage } from "../components/stats-page.js";
import type { SettingsPageModel } from "../settings/page.js";
import type { SettingsSection } from "./settings-sections.js";
import type { DiffStyle } from "./diff-style-pref.js";
import type { ReviewDetailModel } from "./detail-model.js";
import { I18nProvider } from "./i18n.js";
import type { Locale } from "./locale.js";
import { PageLocationProvider } from "./page-location.js";
import { messages } from "./messages.js";
import type { ReviewListModel } from "./list-model.js";
import type { ShellStatus } from "./shell-status.js";
import type { StatsPageModel } from "./stats-model.js";
import { sectionDocumentTitle } from "./settings-copy.js";
import { reviewTreePreload } from "./review-preload.js";

export function renderLoginHtml(input: { next: string; error?: string; locale?: Locale; location?: string }): string {
  const locale = input.locale ?? "en";
  return renderPage(locale, input.location ?? "/ui/login", messages[locale].login.documentTitle, <LoginForm next={input.next} error={input.error} />);
}

export function renderListHtml(model: ReviewListModel, locale: Locale = "en", location = "/ui/reviews"): string {
  return renderPage(locale, location, messages[locale].reviews.documentTitle, <ReviewListView model={model} />);
}

export function renderSettingsHtml(
  model: SettingsPageModel,
  status: ShellStatus | null = null,
  section: SettingsSection = "models",
  locale: Locale = "en",
  location = "/ui/settings",
): string {
  return renderPage(locale, location, sectionDocumentTitle(section, locale), <SettingsForm model={model} status={status} section={section} />);
}

export function renderDetailHtml(model: ReviewDetailModel, locale: Locale = "en", location = "/ui", diffStyle: DiffStyle = "unified"): string {
  return renderPage(locale, location, model.pageTitle, <ReviewDetailView model={model} tree={reviewTreePreload(model.files)} diffStyle={diffStyle} />);
}

export function renderOverviewHtml(model: StatsPageModel, locale: Locale = "en", location = "/ui"): string {
  return renderPage(locale, location, messages[locale].overview.documentTitle, <OverviewPage model={model} />);
}

function renderPage(locale: Locale, location: string, title: string, node: ReactNode): string {
  return documentShell(
    title,
    renderToStaticMarkup(
      <PageLocationProvider location={location}>
        <I18nProvider locale={locale}>{node}</I18nProvider>
      </PageLocationProvider>,
    ),
    locale,
  );
}

function documentShell(title: string, body: string, locale: Locale): string {
  const lang = locale === "zh-CN" ? "zh-CN" : "en";
  const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeTitle(title)}</title></head><body>${body}</body></html>`;
  return html.replaceAll(" dateTime=", " datetime=");
}

function escapeTitle(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
