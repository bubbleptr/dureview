import { uiSessionCookie, uiTokenMatches, safeNextPath } from "../ui/auth.js";
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
    return htmlResponse(renderLoginHtml({ next, error: "token 不正确" }), 401);
  }
  return redirectResponse(next, uiSessionCookie(token));
}
