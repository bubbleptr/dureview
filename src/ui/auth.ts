import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Accept `Authorization: Bearer <token>` or HTTP Basic auth.
 * The Basic username is ignored. The password is the token.
 * The token is not read from the query string.
 */
export function authorizeUi(authorization: string | undefined, token: string): boolean {
  if (!authorization || token.length === 0) return false;
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
