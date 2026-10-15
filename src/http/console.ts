import type { DureviewService } from "../service.js";
import {
  clearGitHubSetupCookie,
  manifestOrigin,
  parseGitHubOrg,
  parseManifestCode,
  readSetupState,
  statesMatch,
} from "../github/manifest.js";
import { settingsReturnPath } from "../ui/settings-sections.js";
import { jsonResponse, redirectResponse } from "./headers.js";

const SETTINGS_PATH = "/ui/settings";

export function isSettingsPoll(request: Request): boolean {
  return new URL(request.url).searchParams.get("poll") === "1";
}

export function isGitHubSetupReturn(request: Request): boolean {
  return new URL(request.url).searchParams.get("setup") === "github";
}

export function settingsPollResponse(service: DureviewService): Response {
  return jsonResponse({ logins: service.loginSnapshot() });
}

export async function settingsGitHubReturn(service: DureviewService, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cookieState = readSetupState(request.headers.get("cookie") ?? undefined);
  const queryState = url.searchParams.get("state") ?? "";
  const code = parseManifestCode(url.searchParams.get("code"));
  if (!cookieState || !statesMatch(cookieState, queryState) || !code) {
    return redirectResponse(`${SETTINGS_PATH}?github=failed`, clearGitHubSetupCookie());
  }
  const result = await service.finishGitHubSetup(queryState, code);
  if (!result.ok) {
    return redirectResponse(`${SETTINGS_PATH}?github=failed`, clearGitHubSetupCookie());
  }
  return redirectResponse(`${SETTINGS_PATH}?github=saved`, clearGitHubSetupCookie());
}

/** Console actions posted to the settings page. `null` means this form is the review-settings form. */
export async function settingsActionResponse(service: DureviewService, request: Request, form: URLSearchParams): Promise<Response | null> {
  const action = form.get("action");
  if (!action) return null;
  if (action === "login") {
    const result = await service.startSubscriptionLogin(form.get("provider") ?? "", form.get("enterprise") ?? "");
    if (!result.ok) return pageWithError(form, result.error);
    return redirectResponse(settingsReturnPath(form.get("section")));
  }
  if (action === "logout") {
    const result = await service.logoutSubscription(form.get("provider") ?? "");
    if (!result.ok) return pageWithError(form, result.error);
    return redirectResponse(settingsReturnPath(form.get("section")));
  }
  if (action === "api-key") {
    const result = await service.saveApiKey(form.get("provider") ?? "", form.get("key") ?? "");
    if (!result.ok) return pageWithError(form, result.error);
    return redirectResponse(settingsReturnPath(form.get("section"), "key=saved"));
  }
  if (action === "api-key-clear") {
    const result = await service.clearApiKey(form.get("provider") ?? "");
    if (!result.ok) return pageWithError(form, result.error);
    return redirectResponse(settingsReturnPath(form.get("section")));
  }
  if (action === "github-manifest") {
    const origin = manifestOrigin(request);
    if (!origin.ok) return pageWithError(form, origin.error);
    const org = parseGitHubOrg(form.get("org") ?? "");
    if (org === undefined) return pageWithError(form, "Organization must be a GitHub slug, or blank for your user.");
    const handoff = service.beginGitHubSetup(origin.origin, org);
    if (!handoff) return pageWithError(form, "GitHub API URL is not a host this page can open.");
    return handoff;
  }
  if (action === "github-clear") {
    const result = await service.clearGitHubApp();
    if (!result.ok) return pageWithError(form, result.error);
    return redirectResponse(settingsReturnPath(form.get("section")));
  }
  return pageWithError(form, "Unknown settings action.");
}

const GITHUB_SETUP_FAILED = "GitHub setup did not finish. Start it again from this page.";

export function settingsNotice(request: Request): string | null {
  const params = new URL(request.url).searchParams;
  if (params.get("github") === "saved") return "GitHub App saved.";
  if (params.get("login") === "ready") return "Signed in.";
  if (params.get("key") === "saved") return "API key saved. The full key is not shown again.";
  return null;
}

export function settingsPageQuery(request: Request): { saved: boolean; notice: string | null; error: string | null } {
  const params = new URL(request.url).searchParams;
  return {
    saved: params.get("saved") === "1",
    notice: settingsNotice(request),
    error: params.get("github") === "failed" ? GITHUB_SETUP_FAILED : problemText(params.get("problem")),
  };
}

function problemText(value: string | null): string | null {
  if (!value) return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
  return text.length > 0 ? text : null;
}

function pageWithError(form: URLSearchParams, error: string): Response {
  return redirectResponse(settingsReturnPath(form.get("section"), `problem=${encodeURIComponent(error)}`));
}
