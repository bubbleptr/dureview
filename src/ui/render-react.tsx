import { renderToStaticMarkup } from "react-dom/server";
import { LoginForm } from "../components/login-form.js";
import { ReviewDetailView } from "../components/review-detail.js";
import { ReviewListView } from "../components/review-list.js";
import { SettingsForm } from "../components/settings-form.js";
import { OverviewPage } from "../components/stats-page.js";
import type { SettingsPageModel } from "../settings/page.js";
import type { SettingsSection } from "./settings-sections.js";
import type { ReviewDetailModel } from "./detail-model.js";
import { I18nProvider } from "./i18n.js";
import type { Locale } from "./locale.js";
import { messages } from "./messages.js";
import type { ReviewListModel } from "./list-model.js";
import type { ShellStatus } from "./shell-status.js";
import type { StatsPageModel } from "./stats-model.js";
import { sectionDocumentTitle } from "./settings-copy.js";
import { reviewTreePreload } from "./review-preload.js";

export function renderLoginHtml(input: { next: string; error?: string; locale?: Locale }): string {
  const locale = input.locale ?? "en";
  return documentShell(
    messages[locale].login.documentTitle,
    renderToStaticMarkup(
      <I18nProvider locale={locale}>
        <LoginForm next={input.next} error={input.error} />
      </I18nProvider>,
    ),
    locale,
  );
}

export function renderListHtml(model: ReviewListModel, locale: Locale = "en"): string {
  return documentShell(
    messages[locale].reviews.documentTitle,
    renderToStaticMarkup(
      <I18nProvider locale={locale}>
        <ReviewListView model={model} />
      </I18nProvider>,
    ),
    locale,
  );
}

export function renderSettingsHtml(
  model: SettingsPageModel,
  status: ShellStatus | null = null,
  section: SettingsSection = "models",
  locale: Locale = "en",
): string {
  return documentShell(
    sectionDocumentTitle(section, locale),
    renderToStaticMarkup(
      <I18nProvider locale={locale}>
        <SettingsForm model={model} status={status} section={section} />
      </I18nProvider>,
    ),
    locale,
  );
}

export function renderDetailHtml(model: ReviewDetailModel, locale: Locale = "en"): string {
  return documentShell(
    model.pageTitle,
    renderToStaticMarkup(
      <I18nProvider locale={locale}>
        <ReviewDetailView model={model} tree={reviewTreePreload(model.files)} />
      </I18nProvider>,
    ),
    locale,
  );
}

export function renderOverviewHtml(model: StatsPageModel, locale: Locale = "en"): string {
  return documentShell(
    messages[locale].overview.documentTitle,
    renderToStaticMarkup(
      <I18nProvider locale={locale}>
        <OverviewPage model={model} />
      </I18nProvider>,
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
