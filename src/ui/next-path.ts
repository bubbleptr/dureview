/** Local path to return to after login. The review list is `/ui`, including a login that started at `/`. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/ui";
  const path = value.split("#")[0]?.split("?")[0] ?? "";
  if (path === "/" || path === "/ui" || path === "/ui/") return "/ui";
  if (path === "/ui/settings" || path === "/ui/settings/") return "/ui/settings";
  if (path === "/ui/stats" || path === "/ui/stats/") return "/ui/stats";
  if (/^\/ui\/reviews\/[A-Za-z0-9_-]{1,64}\/?$/.test(path)) return path;
  return "/ui";
}
