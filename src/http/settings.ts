import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ReviewTrigger } from "../review/policy.js";
import type { SettingsFormValues } from "../settings/page.js";
import type { DureviewService } from "../service.js";
import type { ShellStatus } from "../ui/shell-status.js";
import { safeNextPath } from "../ui/auth.js";
import { renderLoginHtml, renderSettingsHtml } from "../ui/render-react.js";
import { readRawBody } from "./body.js";
import { gateGetPage } from "./auth.js";
import { htmlResponse, notFoundJson, redirectResponse, unauthorizedJson } from "./headers.js";

const BODY_LIMIT = 8_192;
const SETTINGS_PATH = "/ui/settings";

export async function settingsGetResponse(
  service: DureviewService,
  uiToken: string | undefined,
  request: Request,
  status: ShellStatus | null = null,
): Promise<Response> {
  const gate = gateGetPage(request, uiToken);
  if (gate === "disabled") return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  if (gate === "login") return htmlResponse(renderLoginHtml({ next: SETTINGS_PATH }), 401);
  const saved = new URL(request.url).searchParams.get("saved") === "1";
  const model = await service.settingsPage({ saved });
  return htmlResponse(renderSettingsHtml(model, status));
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
  if (gate === "login") return htmlResponse(renderLoginHtml({ next: safeNextPath(SETTINGS_PATH) }), 401);
  let raw: Buffer;
  try {
    raw = await readRawBody(request, BODY_LIMIT);
  } catch {
    const model = await service.settingsPage({ error: "That form was too large to read." });
    return htmlResponse(renderSettingsHtml(model, status), 400);
  }
  const form = new URLSearchParams(raw.toString("utf8"));
  const actor = settingsActor(request);
  const reset = form.get("reset");
  const result = reset
    ? await service.resetSetting(reset, actor)
    : await service.saveSettings(formValues(form), actor);
  if (!result.ok) {
    const model = await service.settingsPage({ error: result.error });
    return htmlResponse(renderSettingsHtml(model, status), 400);
  }
  return redirectResponse(`${SETTINGS_PATH}?saved=1`);
}

/** Operator identity for the audit log. The UI token is not copied here. */
export function settingsActor(request: Request): string {
  const fly = request.headers.get("fly-client-ip")?.trim() ?? "";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = /^[0-9a-fA-F:.]{1,64}$/.test(fly) ? fly : /^[0-9a-fA-F:.]{1,64}$/.test(forwarded) ? forwarded : "";
  return ip ? `ui@${ip}` : "ui";
}

function formValues(form: URLSearchParams): SettingsFormValues {
  const skip = form.get("skipDrafts");
  return {
    model: form.get("model") ?? "",
    thinking: (form.get("thinking") ?? "") as ModelThinkingLevel,
    defaultTrigger: (form.get("defaultTrigger") ?? "") as ReviewTrigger,
    skipDrafts: skip === "true" || skip === "on" || skip === "1",
    checkoutTtlDays: form.get("checkoutTtlDays") ?? "",
  };
}
