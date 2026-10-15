/** Local path to return to after login. Overview is `/ui`. The review list is `/ui/reviews`. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/ui";
  const path = value.split("#")[0]?.split("?")[0] ?? "";
  if (path === "/" || path === "/ui" || path === "/ui/") return "/ui";
  if (path === "/ui/login" || path === "/ui/login/") return "/ui/login";
  if (path === "/ui/reviews" || path === "/ui/reviews/") return "/ui/reviews";
  if (path === "/ui/settings" || path === "/ui/settings/") return "/ui/settings";
  if (path === "/ui/settings/models" || path === "/ui/settings/models/") return "/ui/settings/models";
  if (path === "/ui/settings/github" || path === "/ui/settings/github/") return "/ui/settings/github";
  if (path === "/ui/settings/review" || path === "/ui/settings/review/") return "/ui/settings/review";
  if (path === "/ui/settings/system" || path === "/ui/settings/system/") return "/ui/settings/system";
  if (path === "/ui/stats" || path === "/ui/stats/") return "/ui";
  if (/^\/ui\/reviews\/[A-Za-z0-9_-]{1,64}\/?$/.test(path)) return path;
  return "/ui";
}

const UI_RETURN_LIMIT = 2048;

/**
 * Where a language switch sends the browser. Keeps the path and query.
 * Login's post-login target stays on `safeNextPath`, which drops the query.
 */
export function safeUiReturn(value: string | null | undefined): string {
  if (!value || value.length > UI_RETURN_LIMIT) return "/ui";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/ui";
  if (/[\u0000-\u001F\u007F]/.test(value)) return "/ui";
  const parsed = parseUiReturn(value.split("#")[0] ?? "");
  if (!parsed) return "/ui";
  const decoded = parseUiReturn(decodePath(parsed.pathname));
  if (!decoded) return "/ui";
  const query = parsed.query;
  const result = query ? `${decoded.pathname}?${query}` : decoded.pathname;
  if (result.length > UI_RETURN_LIMIT || result.includes("\\") || /[\u0000-\u001F\u007F]/.test(result)) return "/ui";
  return result;
}

export function requestPathAndQuery(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function parseUiReturn(value: string): { pathname: string; query: string } | null {
  let url: URL;
  try {
    url = new URL(value, "http://dureview.local");
  } catch {
    return null;
  }
  if (url.origin !== "http://dureview.local") return null;
  const pathname = stripTrailingSlash(url.pathname);
  if (pathname !== "/ui" && !pathname.startsWith("/ui/")) return null;
  return { pathname, query: url.searchParams.toString() };
}

function decodePath(pathname: string): string {
  let current = pathname;
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}
