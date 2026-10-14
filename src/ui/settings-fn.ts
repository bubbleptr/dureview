import { createServerFn } from "@tanstack/react-start";
import type { SettingsPageModel } from "../settings/page.js";

export type SettingsPayload = { kind: "login"; next: "/ui/settings" } | { kind: "page"; model: SettingsPageModel };

export const getSettingsPage = createServerFn({ method: "GET" }).handler(async (): Promise<SettingsPayload> => {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { getRuntime } = await import("../app/runtime.js");
  const { uiSession } = await import("../http/auth.js");
  const runtime = await getRuntime();
  const request = getRequest();
  if (uiSession(request, runtime.config.uiToken) !== "ok") return { kind: "login", next: "/ui/settings" };
  const saved = new URL(request.url).searchParams.get("saved") === "1";
  const model = await runtime.service.settingsPage({ saved });
  return { kind: "page", model };
});
