import { createHash, timingSafeEqual } from "node:crypto";

/** Session cookie set by the login form. HttpOnly, so page scripts cannot read it. */
export const UI_COOKIE_NAME = "dureview_ui";

/** Thirty days. The cookie is renewed only by logging in again. */
export const UI_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * Accept `Authorization: Bearer <token>`, HTTP Basic auth, or the login cookie.
 * The Basic username is ignored. The password is the token.
 * The token is not read from the query string.
 */
export function authorizeUi(authorization: string | undefined, token: string, cookieHeader?: string): boolean {
  if (token.length === 0) return false;
  const cookie = readUiCookie(cookieHeader);
  if (cookie !== undefined && safeEqual(cookie, token)) return true;
  return authorizationMatches(authorization, token);
}

/** Compare a login-form token with the configured UI token. */
export function uiTokenMatches(presented: string, expected: string): boolean {
  if (expected.length === 0) return false;
  return safeEqual(presented, expected);
}

/**
 * `Set-Cookie` value. `Secure` so browsers only send it on HTTPS (and on localhost).
 * `SameSite=Lax` so a cross-site form post does not ride an existing session.
 */
export function uiSessionCookie(token: string): string {
  const value = encodeURIComponent(token);
  return `${UI_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${UI_COOKIE_MAX_AGE_SECONDS}`;
}

export function readUiCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const prefix = `${UI_COOKIE_NAME}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length);
    if (raw.length === 0 || raw.length > 4096) return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export { safeNextPath } from "./next-path.js";

function authorizationMatches(authorization: string | undefined, token: string): boolean {
  if (!authorization) return false;
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (bearer?.[1] !== undefined) return safeEqual(bearer[1], token);
  const basic = /^Basic\s+(\S+)\s*$/i.exec(authorization);
  if (basic?.[1] === undefined) return false;
  const decoded = Buffer.from(basic[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  return safeEqual(decoded.slice(colon + 1), token);
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
