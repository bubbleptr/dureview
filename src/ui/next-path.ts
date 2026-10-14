/** Local path to return to after login. Anything else becomes the review list. */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/ui";
  const path = value.split("#")[0]?.split("?")[0] ?? "";
  if (path === "/" || path === "/ui" || path === "/ui/") return path === "/" ? "/" : "/ui";
  if (/^\/ui\/reviews\/[A-Za-z0-9_-]{1,64}\/?$/.test(path)) return path;
  return "/ui";
}
