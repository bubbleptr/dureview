import { uiSessionCookie, uiTokenMatches, safeNextPath } from "../ui/auth.js";
import { resolveLocale } from "../ui/locale.js";
import { messages } from "../ui/messages.js";
import { renderLoginHtml } from "../ui/render-react.js";
import { readRawBody } from "./body.js";
import { htmlResponse, redirectResponse } from "./headers.js";

const LOGIN_BODY_LIMIT = 8_192;

export async function loginPostResponse(request: Request, token: string): Promise<Response> {
  const raw = await readRawBody(request, LOGIN_BODY_LIMIT);
  const form = new URLSearchParams(raw.toString("utf8"));
  const next = safeNextPath(form.get("next"));
  const presented = form.get("token") ?? "";
  if (!uiTokenMatches(presented, token)) {
    const locale = resolveLocale(request);
    return htmlResponse(renderLoginHtml({ next, error: messages[locale].login.badToken, locale }), 401);
  }
  return redirectResponse(next, uiSessionCookie(token));
}
