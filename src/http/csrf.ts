import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SettingsPageModel } from "../settings/page.js";

const PURPOSE = "dureview-settings-post";
const HOST = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/**
 * HMAC of the console token.
 * Browsers attach cached HTTP Basic credentials to a cross-site form POST.
 * SameSite does not apply to that header, so the form has to carry a value a hostile page cannot mint.
 */
export function settingsCsrfToken(uiToken: string): string {
  return createHmac("sha256", uiToken).update(PURPOSE).digest("base64url");
}

export function csrfTokenMatches(presented: string | null, uiToken: string | undefined): boolean {
  if (!uiToken || !presented) return false;
  const expected = createHash("sha256").update(settingsCsrfToken(uiToken)).digest();
  const given = createHash("sha256").update(presented).digest();
  return timingSafeEqual(expected, given);
}

export function withSettingsCsrf(model: SettingsPageModel, uiToken: string | undefined): SettingsPageModel {
  return { ...model, csrf: uiToken ? settingsCsrfToken(uiToken) : "" };
}

/** `Sec-Fetch-Site: same-origin`, or a matching `Origin` when that header is absent. A mismatch on either fails. */
export function postIsSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin !== null && !originAllowed(request, origin)) return false;
  return site === "same-origin" || origin !== null;
}

function originAllowed(request: Request, origin: string): boolean {
  let claimed: URL;
  try {
    claimed = new URL(origin);
  } catch {
    return false;
  }
  if (claimed.origin !== origin) return false;
  if (claimed.origin === new URL(request.url).origin) return true;
  const forwarded = forwardedOrigin(request);
  return forwarded !== null && claimed.origin === forwarded;
}

function forwardedOrigin(request: Request): string | null {
  const proto = headerToken(request.headers.get("x-forwarded-proto"));
  const host = headerToken(request.headers.get("x-forwarded-host"));
  if (!proto || !host) return null;
  if (proto !== "https" && proto !== "http") return null;
  if (!HOST.test(host) || host.length > 255) return null;
  return `${proto}://${host}`;
}

function headerToken(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}
