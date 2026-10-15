import { isLocale, localeCookie } from "../ui/locale.js";
import { safeNextPath } from "../ui/next-path.js";
import { redirectResponse } from "./headers.js";

export function localeSwitchResponse(request: Request): Response {
  const url = new URL(request.url);
  const requested = url.searchParams.get("locale");
  const next = safeNextPath(url.searchParams.get("next"));
  if (!isLocale(requested)) return redirectResponse(next);
  return redirectResponse(next, localeCookie(requested));
}
