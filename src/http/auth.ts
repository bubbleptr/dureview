import { authorizeUi } from "../ui/auth.js";

export type PageGate = "disabled" | "ok" | "challenge" | "login";

/** Credential check for a UI request. Does not look at the path. */
export function uiSession(request: Request, uiToken: string | undefined): "disabled" | "ok" | "no" {
  if (!uiToken) return "disabled";
  const authorization = request.headers.get("authorization") ?? undefined;
  const cookie = request.headers.get("cookie") ?? undefined;
  return authorizeUi(authorization, uiToken, cookie) ? "ok" : "no";
}

/**
 * Gate for `GET /` and `GET /ui`. A presented Authorization header that does not
 * match stays a JSON challenge so `curl -u` does not get the HTML form.
 */
export function gateGetPage(request: Request, uiToken: string | undefined): PageGate {
  const session = uiSession(request, uiToken);
  if (session === "disabled") return "disabled";
  if (session === "ok") return "ok";
  if (request.headers.get("authorization")) return "challenge";
  return "login";
}
