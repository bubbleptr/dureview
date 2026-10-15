export const UI_CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export const UI_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": UI_CSP,
};

export function notFoundJson(): Response {
  return Response.json({ error: "not found" }, { status: 404 });
}

export function unauthorizedJson(): Response {
  const headers = new Headers(UI_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("www-authenticate", 'Basic realm="dureview", charset="UTF-8"');
  return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
}

export function htmlResponse(html: string, status = 200): Response {
  const headers = new Headers(UI_HEADERS);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(html, { status, headers });
}

export function jsonResponse(body: unknown, status = 200): Response {
  const headers = new Headers(UI_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirectResponse(location: string, setCookie?: string | readonly string[]): Response {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  if (typeof setCookie === "string") headers.set("set-cookie", setCookie);
  else if (setCookie) {
    for (const cookie of setCookie) headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 303, headers });
}
