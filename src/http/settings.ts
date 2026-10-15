import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ReviewTrigger } from "../review/policy.js";
import type { SettingsFormValues } from "../settings/page.js";
import type { DureviewService } from "../service.js";
import type { ShellStatus } from "../ui/shell-status.js";
import { safeNextPath } from "../ui/auth.js";
import { resolveLocale } from "../ui/locale.js";
import { messages } from "../ui/messages.js";
import { renderLoginHtml, renderSettingsHtml } from "../ui/render-react.js";
import { readRawBody } from "./body.js";
import { gateGetPage } from "./auth.js";
import { isGitHubSetupReturn, isSettingsPoll, settingsActionResponse, settingsGitHubReturn, settingsPageQuery, settingsPollResponse } from "./console.js";
import { isSettingsSection, settingsReturnPath, settingsSectionFromUrl, type SettingsSection } from "../ui/settings-sections.js";
import { csrfTokenMatches, postIsSameOrigin, withSettingsCsrf } from "./csrf.js";
import { htmlResponse, notFoundJson, redirectResponse, unauthorizedJson } from "./headers.js";

const BODY_LIMIT = 8_192;

export async function settingsGetResponse(
  service: DureviewService,
  uiToken: string | undefined,
  request: Request,
  status: ShellStatus | null = null,
): Promise<Response> {
  const gate = gateGetPage(request, uiToken);
  if (gate === "disabled") return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  const locale = resolveLocale(request);
  if (gate === "login") {
    if (isSettingsPoll(request) || isGitHubSetupReturn(request)) return unauthorizedJson();
    return htmlResponse(renderLoginHtml({ next: safeNextPath(new URL(request.url).pathname), locale }), 401);
  }
  if (isSettingsPoll(request)) return settingsPollResponse(service);
  if (isGitHubSetupReturn(request)) return settingsGitHubReturn(service, request);
  const model = withSettingsCsrf(await service.settingsPage(settingsPageQuery(request)), uiToken);
  return htmlResponse(renderSettingsHtml(model, status, settingsSectionFromUrl(new URL(request.url)), locale));
}

export async function settingsPostResponse(
  service: DureviewService,
  uiToken: string | undefined,
  request: Request,
  status: ShellStatus | null = null,
): Promise<Response> {
  const gate = gateGetPage(request, uiToken);
  if (gate === "disabled") return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  const locale = resolveLocale(request);
  if (gate === "login") return htmlResponse(renderLoginHtml({ next: safeNextPath(new URL(request.url).pathname), locale }), 401);
  if (!postIsSameOrigin(request)) return htmlResponse(messages[locale].server.crossSite, 403);
  let raw: Buffer;
  try {
    raw = await readRawBody(request, BODY_LIMIT);
  } catch {
    const model = withSettingsCsrf(await service.settingsPage({ error: messages.en.server.formTooLarge }), uiToken);
    return htmlResponse(renderSettingsHtml(model, status, settingsSectionFromUrl(new URL(request.url)), locale), 400);
  }
  const form = new URLSearchParams(raw.toString("utf8"));
  if (!csrfTokenMatches(form.get("csrf"), uiToken)) return htmlResponse(messages[locale].server.crossSite, 403);
  const action = await settingsActionResponse(service, request, form);
  if (action) return action;
  const actor = settingsActor(request);
  const reset = form.get("reset");
  const result = reset
    ? await service.resetSetting(reset, actor)
    : await service.saveSettings(formValues(form), actor);
  if (!result.ok) {
    const model = withSettingsCsrf(await service.settingsPage({ error: result.error }), uiToken);
    return htmlResponse(renderSettingsHtml(model, status, postedSection(request, form), locale), 400);
  }
  return redirectResponse(settingsReturnPath(form.get("section"), "saved=1"));
}

function postedSection(request: Request, form: URLSearchParams): SettingsSection {
  const posted = form.get("section");
  if (isSettingsSection(posted)) return posted;
  return settingsSectionFromUrl(new URL(request.url));
}

/** Operator identity for the audit log. The UI token is not copied here. */
export function settingsActor(request: Request): string {
  const fly = request.headers.get("fly-client-ip")?.trim() ?? "";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = /^[0-9a-fA-F:.]{1,64}$/.test(fly) ? fly : /^[0-9a-fA-F:.]{1,64}$/.test(forwarded) ? forwarded : "";
  return ip ? `ui@${ip}` : "ui";
}

function formValues(form: URLSearchParams): Partial<SettingsFormValues> {
  const values: Partial<SettingsFormValues> = {};
  if (form.has("provider")) values.provider = form.get("provider") ?? "";
  if (form.has("model")) values.model = form.get("model") ?? "";
  if (form.has("thinking")) values.thinking = (form.get("thinking") ?? "") as ModelThinkingLevel;
  if (form.has("defaultTrigger")) values.defaultTrigger = (form.get("defaultTrigger") ?? "") as ReviewTrigger;
  if (form.has("skipDrafts")) {
    values.skipDrafts = form.getAll("skipDrafts").some((value) => value === "true" || value === "on" || value === "1");
  }
  if (form.has("checkoutTtlDays")) values.checkoutTtlDays = form.get("checkoutTtlDays") ?? "";
  return values;
}
