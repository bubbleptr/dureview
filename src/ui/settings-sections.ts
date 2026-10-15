export const SETTINGS_SECTIONS = ["models", "github", "review", "system"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return value === "models" || value === "github" || value === "review" || value === "system";
}

export function settingsSectionHref(section: SettingsSection): string {
  return `/ui/settings/${section}`;
}

/** `/ui/settings/:section` wins. On `/ui/settings`, `?section=` wins, then a notice that belongs to GitHub. */
export function settingsSectionFromUrl(url: URL): SettingsSection {
  const path = stripSlash(url.pathname);
  const fromPath = /^\/ui\/settings\/([^/]+)$/.exec(path)?.[1];
  if (isSettingsSection(fromPath)) return fromPath;
  const query = url.searchParams.get("section");
  if (isSettingsSection(query)) return query;
  if (url.searchParams.has("github")) return "github";
  return "models";
}

export function isSettingsCandidate(pathname: string): boolean {
  const path = stripSlash(pathname);
  return path === "/ui/settings" || /^\/ui\/settings\/[^/]+$/.test(path);
}

export function isKnownSettingsPath(pathname: string): boolean {
  const path = stripSlash(pathname);
  if (path === "/ui/settings") return true;
  const section = /^\/ui\/settings\/([^/]+)$/.exec(path)?.[1];
  return isSettingsSection(section);
}

/** Redirect target after a settings POST. An unknown section stays on `/ui/settings`. */
export function settingsReturnPath(section: string | null, query = ""): string {
  const path = isSettingsSection(section) ? settingsSectionHref(section) : "/ui/settings";
  return query ? `${path}?${query}` : path;
}

function stripSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}
