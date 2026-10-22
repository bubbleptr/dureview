export const DIFF_STYLE_KEY = "dureview-diff-style";

export const DIFF_STYLE_COOKIE = "dureview-diff-style";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type DiffStyle = "unified" | "split";

export function isDiffStyle(value: unknown): value is DiffStyle {
  return value === "unified" || value === "split";
}

export function diffStyleFromCookieHeader(header: string | null | undefined): DiffStyle | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== DIFF_STYLE_COOKIE) continue;
    const value = decodeCookie(trimmed.slice(eq + 1));
    return isDiffStyle(value) ? value : null;
  }
  return null;
}

export function resolveDiffStyle(request: { headers: { get(name: string): string | null } }): DiffStyle {
  return diffStyleFromCookieHeader(request.headers.get("cookie")) ?? "unified";
}

export function diffStyleCookie(style: DiffStyle): string {
  return `${DIFF_STYLE_COOKIE}=${style}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

function decodeCookie(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
