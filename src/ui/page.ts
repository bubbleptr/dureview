import type { ReviewLogEntry } from "../review/history.js";
import type { DashboardStatus } from "./status.js";

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Public pull request URL, or null when the coordinates are not safe to put in an href. */
export function pullRequestUrl(apiUrl: string, owner: string, repo: string, number: number): string | null {
  if (!NAME.test(owner) || owner.length > 100 || !NAME.test(repo) || repo.length > 100) return null;
  if (!Number.isInteger(number) || number < 1) return null;
  let web: string;
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    web = url.hostname === "api.github.com" ? "https://github.com" : url.origin;
  } catch {
    return null;
  }
  return `${web}/${owner}/${repo}/pull/${number}`;
}

export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

export function renderDashboard(status: DashboardStatus, githubApiUrl: string): string {
  const rows = status.reviews.map((review) => reviewRow(review, githubApiUrl)).join("");
  const reviews =
    status.reviews.length === 0
      ? `<p>No reviews yet.</p>`
      : `<table>
<thead><tr><th>When</th><th>Repository</th><th>Pull request</th><th>Trigger</th><th>Outcome</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>dureview</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; max-width: 56rem; padding: 2rem 1.25rem 3rem; }
  h1 { font-size: 1.35rem; font-weight: 650; margin: 0 0 1.5rem; }
  h2 { font-size: 0.8rem; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; margin: 0 0 0.75rem; }
  section + section { margin-top: 2rem; }
  dl { display: grid; grid-template-columns: 10rem 1fr; gap: 0.35rem 1rem; margin: 0; }
  dt { color: color-mix(in srgb, CanvasText 60%, transparent); }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.45rem 0.6rem 0.45rem 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 18%, transparent); vertical-align: top; }
  th { font-size: 0.75rem; letter-spacing: 0.03em; text-transform: uppercase; font-weight: 650; color: color-mix(in srgb, CanvasText 60%, transparent); }
  a { color: inherit; }
  p { margin: 0; }
</style>
</head>
<body>
<main>
<h1>dureview</h1>
<section>
<h2>Status</h2>
<dl>
<dt>Version</dt><dd>${escapeHtml(status.version)}</dd>
<dt>Uptime</dt><dd>${escapeHtml(formatUptime(status.uptimeSeconds * 1000))}</dd>
<dt>Provider</dt><dd>${escapeHtml(status.provider)}</dd>
<dt>Model</dt><dd>${escapeHtml(status.model)}</dd>
<dt>Codex login</dt><dd>${escapeHtml(codexLabel(status.codex))}</dd>
<dt>GitHub App</dt><dd>${status.githubApp ? "yes" : "no"}</dd>
<dt>GitHub token</dt><dd>${status.githubToken ? "yes" : "no"}</dd>
</dl>
</section>
<section>
<h2>Recent reviews</h2>
${reviews}
</section>
</main>
</body>
</html>
`;
}

function reviewRow(review: ReviewLogEntry, githubApiUrl: string): string {
  const href = pullRequestUrl(githubApiUrl, review.owner, review.repo, review.number);
  const label = `#${review.number}`;
  const pull = href ? `<a href="${escapeHtml(href)}" rel="noreferrer">${label}</a>` : escapeHtml(label);
  const repo = `${escapeHtml(review.owner)}/${escapeHtml(review.repo)}`;
  return `<tr><td>${escapeHtml(formatTime(review.startedAt))}</td><td>${repo}</td><td>${pull}</td><td>${escapeHtml(triggerLabel(review.trigger))}</td><td>${escapeHtml(outcomeLabel(review))}</td></tr>`;
}

function codexLabel(codex: DashboardStatus["codex"]): string {
  if (codex.unreadable) return "unreadable";
  if (!codex.present) return "not signed in";
  if (!codex.expiresAt) return "signed in";
  const when = formatTime(codex.expiresAt);
  const expiry = Date.parse(codex.expiresAt);
  if (Number.isNaN(expiry) || when === "") return "signed in";
  if (expiry <= Date.now()) return `signed in, access token expired ${when}`;
  return `signed in, access token expires ${when}`;
}

function triggerLabel(trigger: string): string {
  return trigger === "command" ? "/dureview" : trigger;
}

function outcomeLabel(review: ReviewLogEntry): string {
  if (review.outcome === "running") return "running";
  if (review.outcome === "failed") return "failed";
  const verdict =
    review.verdict === "fix_recommended"
      ? "fix recommended"
      : review.verdict === "block"
        ? "block"
        : review.verdict === "clean"
          ? "clean"
          : "completed";
  if (review.findingCount === null) return verdict;
  const noun = review.findingCount === 1 ? "finding" : "findings";
  return `${verdict} · ${review.findingCount} ${noun}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
