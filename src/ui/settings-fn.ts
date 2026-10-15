import { createServerFn } from "@tanstack/react-start";
import type { SettingsPageModel } from "../settings/page.js";
import { settingsSectionFromUrl, type SettingsSection } from "./settings-sections.js";
import { safeNextPath } from "./next-path.js";

export type SettingsPayload =
  | { kind: "login"; next: string }
  | { kind: "page"; model: SettingsPageModel; section: SettingsSection };

export const getSettingsPage = createServerFn({ method: "GET" }).handler(async (): Promise<SettingsPayload> => {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { getRuntime } = await import("../app/runtime.js");
  const { uiSession } = await import("../http/auth.js");
  const { settingsPageQuery } = await import("../http/console.js");
  const { withSettingsCsrf } = await import("../http/csrf.js");
  const runtime = await getRuntime();
  const request = getRequest();
  const url = new URL(request.url);
  const next = safeNextPath(url.pathname);
  if (uiSession(request, runtime.config.uiToken) !== "ok") return { kind: "login", next };
  const model = withSettingsCsrf(await runtime.service.settingsPage(settingsPageQuery(request)), runtime.config.uiToken);
  return { kind: "page", model, section: settingsSectionFromUrl(url) };
});
