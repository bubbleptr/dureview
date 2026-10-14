/** Local path to return to after login. Overview is `/ui`. The review list is `/ui/reviews`. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/ui";
  const path = value.split("#")[0]?.split("?")[0] ?? "";
  if (path === "/" || path === "/ui" || path === "/ui/") return "/ui";
  if (path === "/ui/reviews" || path === "/ui/reviews/") return "/ui/reviews";
  if (path === "/ui/settings" || path === "/ui/settings/") return "/ui/settings";
  if (path === "/ui/stats" || path === "/ui/stats/") return "/ui";
  if (/^\/ui\/reviews\/[A-Za-z0-9_-]{1,64}\/?$/.test(path)) return path;
  return "/ui";
}
