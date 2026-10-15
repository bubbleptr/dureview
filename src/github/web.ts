const WEB_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/**
 * Browser host for a GitHub API URL.
 * GitHub.com's API lives on `api.github.com` while the website is `github.com`.
 * GitHub Enterprise serves both from the same origin.
 */
export function githubWebOrigin(apiUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  const origin = url.hostname === "api.github.com" ? "https://github.com" : url.origin;
  return WEB_ORIGIN.test(origin) ? origin : null;
}
