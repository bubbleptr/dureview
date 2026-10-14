import type { PullFile } from "../github/client.js";
import {
  reviewResult,
  type ReviewDetail,
  type ReviewResultKind,
  type ReviewSummary,
  type StoredComment,
  type StoredPolicy,
} from "../review/archive.js";
import type { DashboardStatus } from "./status.js";
import { fileStatusMark, placeReview, type PlacedFile, type PlacedLine } from "./diff.js";
import { formIsFiltered, type ReviewFormState } from "./query.js";

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

/** A review still marked running after this long is shown as stuck, not as a growing duration. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;

export function runningLabel(startedAt: string, now: number): "进行中" | "疑似卡住" {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "进行中";
  if (now - start >= STUCK_AFTER_MS) return "疑似卡住";
  return "进行中";
}

function durationText(
  startedAt: string,
  finishedAt: string | null,
  outcome: string,
  now: number,
): string {
  if (outcome === "running") return runningLabel(startedAt, now);
  return formatDuration(reviewDurationMs(startedAt, finishedAt, now));
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return secs === 0 ? `${minutes}m` : `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

export function reviewDurationMs(startedAt: string, finishedAt: string | null, now = Date.now()): number | null {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** Automatic pull request events are `auto`. A comment command is `/dureview`. */
export function displayTrigger(trigger: string): string {
  if (trigger === "command") return "/dureview";
  if (trigger === "opened" || trigger === "synchronize" || trigger === "reopened" || trigger === "ready_for_review") {
    return "auto";
  }
  return "—";
}

export function resultLabel(kind: ReviewResultKind): string {
  if (kind === "pass") return "Pass";
  if (kind === "suggest") return "Suggestions";
  if (kind === "blocker") return "P0/P1";
  if (kind === "error") return "Error";
  return "Running";
}

export function renderReviewList(input: {
  status: DashboardStatus;
  reviews: ReviewSummary[];
  repos: string[];
  total: number;
  form: ReviewFormState;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const rows = input.reviews.map((review) => reviewRow(review, now)).join("");
  const empty =
    input.total === 0
      ? `<p class="empty">No reviews yet.</p>`
      : input.reviews.length === 0
        ? `<p class="empty">No reviews match these filters.</p>`
        : "";
  const table =
    input.reviews.length === 0
      ? empty
      : `<div class="table-wrap"><table>
<thead><tr>
<th>Repository</th><th>Title</th><th>Trigger</th><th>Result</th>
<th class="num p0">P0</th><th class="num p1">P1</th><th class="num p2">P2</th><th class="num p3">P3</th>
<th class="num">Duration</th><th>When</th>
</tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
  const repos = uniqueRepos(input.repos, input.form.repo);
  return document(
    "dureview",
    "list",
    `<div class="list-wrap">
<header class="list-head">
  <h1>dureview</h1>
  <p class="statusline">${statusLine(input.status)}</p>
</header>
<form class="filters" method="get" action="/ui">
  <label>Repository <select name="repo">${repoOptions(repos, input.form.repo)}</select></label>
  <label>Result <select name="result">${resultOptions(input.form.result)}</select></label>
  <label>Time <select name="since">${sinceOptions(input.form.since)}</select></label>
  <label>From <input type="date" name="from" value="${escapeHtml(input.form.from)}"></label>
  <label>To <input type="date" name="to" value="${escapeHtml(input.form.to)}"></label>
  <label class="grow">Search <input type="search" name="q" value="${escapeHtml(input.form.q)}" placeholder="Title, repository, or PR"></label>
  <button type="submit">Apply</button>
  ${formIsFiltered(input.form) ? `<a class="clear" href="/ui">Clear</a>` : ""}
</form>
<p class="count">${input.reviews.length} shown${input.total === input.reviews.length ? "" : ` of ${input.total}`}</p>
${table}
</div>`,
  );
}

export function renderReviewDetail(input: {
  review: ReviewDetail;
  files: PullFile[];
  diffUnavailable: boolean;
  githubApiUrl: string;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  const review = input.review;
  const kind = reviewResult(review);
  const href = pullRequestUrl(input.githubApiUrl, review.owner, review.repo, review.number);
  const label = `${escapeHtml(review.owner)}/${escapeHtml(review.repo)} #${review.number}`;
  const pull = href ? `<a class="pr" href="${escapeHtml(href)}" rel="noreferrer">${label}</a>` : `<span class="pr">${label}</span>`;
  const placed = placeReview(input.files, review.comments);
  const duration = durationText(review.startedAt, review.finishedAt, review.outcome, now);
  const when = timeElement(review.finishedAt ?? review.startedAt);
  return document(
    `${review.owner}/${review.repo} #${review.number}`,
    "detail",
    `<header class="topbar">
  <a class="back" href="/ui">Reviews</a>
  ${pull}
  <h1>${escapeHtml(review.title || "Untitled")}</h1>
  ${badge(kind)}
  <span class="tag">${escapeHtml(displayTrigger(review.trigger))}</span>
  <span class="muted">${escapeHtml(duration)}</span>
  <span class="muted">${when}</span>
</header>
<div class="columns">
  <aside class="col tree">
    <p class="col-label">Files</p>
    ${fileTree(placed.files)}
    ${placed.hiddenFiles > 0 ? `<p class="note-line">${placed.hiddenFiles} more files are not shown.</p>` : ""}
  </aside>
  <main class="col diff">
    ${diffColumn(placed.files, placed.outside, input.diffUnavailable, placed.hiddenFiles)}
  </main>
  <aside class="col rail">
    ${summaryRail(review, now)}
    ${settingsRail(review)}
  </aside>
</div>`,
  );
}

function reviewRow(review: ReviewSummary, now: number): string {
  const kind = reviewResult(review);
  const href = `/ui/reviews/${encodeURIComponent(review.taskId)}`;
  const repo = `${escapeHtml(review.owner)}/${escapeHtml(review.repo)} #${review.number}`;
  const duration = durationText(review.startedAt, review.finishedAt, review.outcome, now);
  return `<tr>
<td><a class="rowlink" href="${href}">${repo}</a></td>
<td>${escapeHtml(review.title || "—")}</td>
<td><span class="tag">${escapeHtml(displayTrigger(review.trigger))}</span></td>
<td>${badge(kind)}</td>
${priorityCell("p0", review.p0, review.countsKnown)}
${priorityCell("p1", review.p1, review.countsKnown)}
${priorityCell("p2", review.p2, review.countsKnown)}
${priorityCell("p3", review.p3, review.countsKnown)}
<td class="num">${escapeHtml(duration)}</td>
<td class="when">${timeElement(review.startedAt)}</td>
</tr>`;
}

function priorityCell(level: string, count: number, known: boolean): string {
  if (!known) return `<td class="num">—</td>`;
  const on = count > 0 ? ` on ${level}` : "";
  return `<td class="num${on}">${count}</td>`;
}

function badge(kind: ReviewResultKind): string {
  return `<span class="badge ${kind}">${escapeHtml(resultLabel(kind))}</span>`;
}

function fileTree(files: PlacedFile[]): string {
  if (files.length === 0) return `<p class="note-line">No changed files.</p>`;
  const root: TreeDir = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.filename.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!part) continue;
      let child = node.dirs.get(part);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  return `<ul class="nodes">${renderDir(root)}</ul>`;
}

type TreeDir = { dirs: Map<string, TreeDir>; files: PlacedFile[] };

function renderDir(node: TreeDir): string {
  const entries: Array<{ name: string; html: string }> = [];
  for (const [name, child] of node.dirs) {
    entries.push({
      name,
      html: `<li class="dir"><span class="dirname">${escapeHtml(name)}</span><ul class="nodes">${renderDir(child)}</ul></li>`,
    });
  }
  for (const file of node.files) {
    const leaf = file.filename.split("/").at(-1) ?? file.filename;
    entries.push({
      name: leaf,
      html: `<li><a href="#${file.anchor}"><span class="mark">${fileStatusMark(file.status)}</span>${escapeHtml(leaf)}</a></li>`,
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries.map((entry) => entry.html).join("");
}

function diffColumn(files: PlacedFile[], outside: StoredComment[], unavailable: boolean, hiddenFiles: number): string {
  const banner = unavailable
    ? `<p class="banner">The diff could not be loaded from GitHub. Saved comments are still listed.</p>`
    : "";
  const hidden = hiddenFiles > 0 ? `<p class="banner">${hiddenFiles} files are hidden on this page.</p>` : "";
  if (files.length === 0 && !unavailable) {
    return `${banner}${hidden}<p class="empty">GitHub returned no changed files.</p>${commentGroup("Comments", outside)}`;
  }
  return `${banner}${hidden}${files.map(renderFile).join("")}${commentGroup("Other files", outside)}`;
}

function renderFile(file: PlacedFile): string {
  const stats = file.patchMissing ? "" : `<span class="muted">+${file.additions} −${file.deletions}</span>`;
  const body = file.patchMissing
    ? `<p class="note-line">GitHub did not include a patch for this file.</p>`
    : file.lines.map(renderLine).join("");
  const truncated = file.patchTruncated ? `<p class="note-line">Patch truncated.</p>` : "";
  return `<section class="file" id="${file.anchor}">
<header class="file-head"><span class="path">${escapeHtml(file.filename)}</span><span class="tag">${escapeHtml(file.status)}</span>${stats}</header>
<div class="patch">${body}</div>
${truncated}
${commentGroup("Not on a line in this diff", file.unanchored)}
</section>`;
}

function renderLine(line: PlacedLine): string {
  if (line.kind === "hunk") return `<div class="hunk">${escapeHtml(line.text)}</div>`;
  const severity = line.severity === null ? "" : ` sev-${line.severity}`;
  const mark = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const oldNo = line.oldLine === null ? "" : String(line.oldLine);
  const newNo = line.newLine === null ? "" : String(line.newLine);
  const notes = line.comments.map(renderComment).join("");
  return `<div class="line${severity}"><span class="gutter">${oldNo}</span><span class="gutter">${newNo}</span><span class="mark">${mark}</span><code>${escapeHtml(line.text)}</code></div>${notes}`;
}

function commentGroup(title: string, comments: StoredComment[]): string {
  if (comments.length === 0) return "";
  return `<div class="unanchored"><p class="col-label">${escapeHtml(title)}</p>${comments.map(renderComment).join("")}</div>`;
}

function renderComment(comment: StoredComment): string {
  const suggestion = comment.suggestion
    ? `<pre class="suggestion">${escapeHtml(comment.suggestion)}</pre>`
    : "";
  const evidence =
    comment.evidence.length > 0
      ? `<p class="evidence">${comment.evidence.map((item) => escapeHtml(item)).join("<br>")}</p>`
      : "";
  const trigger = comment.trigger ? `<p class="trigger"><span class="k">Trigger</span> ${escapeHtml(comment.trigger)}</p>` : "";
  return `<article class="comment p${comment.priority}" id="c-${comment.ordinal}">
<header>
  <span class="tag p${comment.priority}">P${comment.priority}</span>
  ${kindTags(comment.kind, comment.category)}
  <span class="muted">${Math.round(comment.confidence * 100)}%</span>
</header>
<h3>${escapeHtml(comment.title)}</h3>
<p>${escapeHtml(comment.body)}</p>
${trigger}
${evidence}
${suggestion}
</article>`;
}

function kindTags(kind: string, category: string): string {
  const left = kind.trim();
  const right = category.trim();
  if (left.length > 0 && left.toLowerCase() === right.toLowerCase()) {
    return `<span class="tag">${escapeHtml(left)}</span>`;
  }
  const tags = [`<span class="tag">${escapeHtml(left)}</span>`];
  if (right.length > 0) tags.push(`<span class="tag">${escapeHtml(right)}</span>`);
  return tags.join("");
}

function summaryRail(review: ReviewDetail, now: number): string {
  const kind = reviewResult(review);
  if (review.outcome !== "completed") {
    const status =
      review.outcome === "failed"
        ? review.error || "审查失败，没有记录原因。"
        : runningLabel(review.startedAt, now);
    return `<section>
<h2>Summary</h2>
${badge(kind)}
<p class="status-note">${escapeHtml(status)}</p>
</section>`;
  }
  const reason = review.verdictReason ? `<p class="reason">${escapeHtml(review.verdictReason)}</p>` : "";
  const verdict = review.verdict ? `<p class="verdict ${verdictClass(review.verdict)}">${escapeHtml(verdictLabel(review.verdict))}</p>` : "";
  const checked =
    review.checked.length === 0
      ? ""
      : `<ul class="checked">${review.checked.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  const links =
    review.comments.length === 0
      ? `<p class="note-line">No saved comments.</p>`
      : `<ul class="findings">${review.comments
          .map(
            (comment) =>
              `<li><a href="#c-${comment.ordinal}"><span class="tag p${comment.priority}">P${comment.priority}</span>${escapeHtml(comment.title)}<span class="where">${escapeHtml(comment.path)}:${comment.startLine}</span></a></li>`,
          )
          .join("")}</ul>`;
  return `<section>
<h2>Summary</h2>
${badge(kind)}
${verdict}
${reason}
<dl class="counts">
<dt class="p0">P0</dt><dd class="${review.p0 > 0 ? "p0" : ""}">${countOrDash(review.p0, review.countsKnown)}</dd>
<dt class="p1">P1</dt><dd class="${review.p1 > 0 ? "p1" : ""}">${countOrDash(review.p1, review.countsKnown)}</dd>
<dt class="p2">P2</dt><dd class="${review.p2 > 0 ? "p2" : ""}">${countOrDash(review.p2, review.countsKnown)}</dd>
<dt class="p3">P3</dt><dd class="${review.p3 > 0 ? "p3" : ""}">${countOrDash(review.p3, review.countsKnown)}</dd>
</dl>
${links}
${checked}
</section>`;
}

function settingsRail(review: ReviewDetail): string {
  const policy = review.policy;
  const rows = policy
    ? settingRows(policy, review)
    : `<p class="note-line">Settings were not recorded for this review.</p>`;
  return `<section><h2>Settings</h2>${rows}</section>`;
}

function settingRows(policy: StoredPolicy, review: ReviewDetail): string {
  const model = [review.provider, review.model].filter((part) => part && part.length > 0).join("/");
  const pairs: Array<[string, string]> = [
    ["trigger", policy.trigger],
    ["drafts", policy.drafts ? "true" : "false"],
    ["profile", policy.profile],
    ["language", policy.language],
    ["summary", policy.summary ? "true" : "false"],
    ["min confidence", String(policy.minConfidence)],
    ["inline through", `P${policy.minInlinePriority}`],
    ["P2 inline confidence", String(policy.p2InlineMinConfidence)],
    ["max inline", String(policy.maxInline)],
  ];
  if (model) pairs.push(["model", model]);
  if (review.baseRef) pairs.push(["base", review.baseRef]);
  if (review.sha) pairs.push(["head", review.sha.slice(0, 7)]);
  return `<dl class="settings">${pairs
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value)}</dd>`)
    .join("")}</dl>`;
}

function countOrDash(count: number, known: boolean): string {
  return known ? String(count) : "—";
}

function verdictLabel(verdict: string): string {
  if (verdict === "fix_recommended") return "Fix recommended";
  if (verdict === "block") return "Block";
  if (verdict === "clean") return "Clean";
  return verdict;
}

function verdictClass(verdict: string): string {
  if (verdict === "block") return "blocker";
  if (verdict === "fix_recommended") return "suggest";
  if (verdict === "clean") return "pass";
  return "";
}

function statusLine(status: DashboardStatus): string {
  return [
    escapeHtml(status.version),
    `up ${escapeHtml(formatUptime(status.uptimeSeconds * 1000))}`,
    `${escapeHtml(status.provider)}/${escapeHtml(status.model)}`,
    codexLabel(status.codex),
    `GitHub App <b>${status.githubApp ? "yes" : "no"}</b>`,
    `GitHub token <b>${status.githubToken ? "yes" : "no"}</b>`,
  ].join(" · ");
}

export type CodexPhrase =
  | { kind: "plain"; text: string }
  | { kind: "timed"; lead: string; iso: string; label: string };

/** Same wording the status line uses for the Codex credential. `label` is the UTC timestamp. */
export function codexPhrase(codex: DashboardStatus["codex"], now = Date.now()): CodexPhrase {
  if (codex.unreadable) return { kind: "plain", text: "Codex login unreadable" };
  if (!codex.present) return { kind: "plain", text: "Codex not signed in" };
  if (!codex.expiresAt) return { kind: "plain", text: "Codex signed in" };
  const label = formatTime(codex.expiresAt);
  const expiry = Date.parse(codex.expiresAt);
  if (Number.isNaN(expiry) || label === "") return { kind: "plain", text: "Codex signed in" };
  if (expiry <= now) return { kind: "timed", lead: "Codex signed in, access token expired ", iso: codex.expiresAt, label };
  return { kind: "timed", lead: "Codex signed in, access token expires ", iso: codex.expiresAt, label };
}

function codexLabel(codex: DashboardStatus["codex"]): string {
  const phrase = codexPhrase(codex);
  if (phrase.kind === "plain") return phrase.text;
  return `${phrase.lead}${timeElement(phrase.iso)}`;
}

function repoOptions(repos: string[], selected: string): string {
  const options = [`<option value="">All repositories</option>`];
  for (const repo of repos) {
    const sel = repo === selected ? " selected" : "";
    options.push(`<option value="${escapeHtml(repo)}"${sel}>${escapeHtml(repo)}</option>`);
  }
  return options.join("");
}

function resultOptions(selected: ReviewFormState["result"]): string {
  const options: Array<[string, string]> = [
    ["", "All results"],
    ["pass", "Pass"],
    ["suggest", "Suggestions"],
    ["blocker", "P0/P1"],
    ["error", "Error"],
    ["running", "Running"],
  ];
  return options
    .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
    .join("");
}

function sinceOptions(selected: ReviewFormState["since"]): string {
  const options: Array<[string, string]> = [
    ["", "Any time"],
    ["24h", "Last 24 hours"],
    ["7d", "Last 7 days"],
    ["30d", "Last 30 days"],
  ];
  return options
    .map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`)
    .join("");
}

function uniqueRepos(repos: string[], selected: string): string[] {
  const set = new Set(repos);
  if (selected) set.add(selected);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function document(title: string, bodyClass: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body class="${bodyClass}">
${body}
${LOCAL_TIME_SCRIPT}
</body>
</html>
`;
}

export function renderLogin(input: { next: string; error?: string }): string {
  const error = input.error ? `<p class="login-error">${escapeHtml(input.error)}</p>` : "";
  return document(
    "登录 · dureview",
    "login",
    `<div class="login-wrap">
<form class="login" method="post" action="/ui/login">
  <h1>dureview</h1>
  <p class="muted">输入 UI token 后继续。</p>
  ${error}
  <input type="hidden" name="next" value="${escapeHtml(input.next)}">
  <label>UI token
    <input type="password" name="token" autocomplete="current-password" required autofocus>
  </label>
  <button type="submit">登录</button>
</form>
</div>`,
  );
}

function timeElement(iso: string): string {
  const shown = formatTime(iso);
  if (!shown) return "";
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(shown)}</time>`;
}

const LOCAL_TIME_SCRIPT = `<script>
document.querySelectorAll("time[datetime]").forEach(function (el) {
  var raw = el.getAttribute("datetime");
  if (!raw) return;
  var date = new Date(raw);
  if (Number.isNaN(date.getTime())) return;
  el.textContent = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).format(date);
  el.title = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short"
  }).format(date);
});
</script>`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #1f2328; font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: underline; }
  h1, h2, h3, p { margin: 0; }
  button, input, select { font: inherit; color: inherit; background: #fff; border: 1px solid #e6e6e6; border-radius: 6px; }
  button { padding: 0.35rem 0.7rem; cursor: pointer; }
  input, select { padding: 0.3rem 0.45rem; }
  .muted { color: #656d76; }
  .tag { display: inline-block; border: 1px solid #e6e6e6; border-radius: 999px; padding: 0 0.45rem; font-size: 11px; line-height: 1.6; color: #656d76; background: #fff; }
  .badge { display: inline-block; border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 11px; line-height: 1.7; font-weight: 600; }
  .badge.pass, .verdict.pass { color: #1a7f37; background: #f3faf5; }
  .badge.suggest, .verdict.suggest { color: #9a6700; background: #fff8e8; }
  .badge.blocker, .verdict.blocker { color: #cf222e; background: #fff1f0; }
  .badge.error, .badge.running { color: #57606a; background: #f6f8fa; }
  .tag.p0, .on.p0, dd.p0, dt.p0 { color: #cf222e; }
  .tag.p0 { background: #fff1f0; border-color: #ffd7d5; }
  .tag.p1, .on.p1, dd.p1, dt.p1 { color: #bc4c00; }
  .tag.p1 { background: #fff5ef; border-color: #ffd8c2; }
  .tag.p2, .on.p2, dd.p2, dt.p2 { color: #9a6700; }
  .tag.p2 { background: #fff8e8; border-color: #f5e6b8; }
  .tag.p3, .on.p3, dd.p3, dt.p3 { color: #57606a; }
  .tag.p3 { background: #f6f8fa; border-color: #e6e6e6; }
  th.p0 { color: #cf222e; }
  th.p1 { color: #bc4c00; }
  th.p2 { color: #9a6700; }
  th.p3 { color: #57606a; }
  .list-wrap { max-width: 1440px; margin: 0 auto; padding: 1.25rem 1.25rem 3rem; }
  .list-head h1 { font-size: 16px; font-weight: 650; }
  .statusline { margin-top: 0.35rem; color: #656d76; font-size: 12px; }
  .statusline b { font-weight: 600; color: #1f2328; }
  .filters { display: flex; flex-wrap: wrap; gap: 0.6rem 0.75rem; align-items: end; margin: 1rem 0 0.6rem; }
  .filters label { display: flex; flex-direction: column; gap: 0.2rem; color: #656d76; font-size: 11px; }
  .filters .grow { flex: 1 1 12rem; }
  .filters .grow input { width: 100%; }
  .clear { align-self: center; color: #656d76; font-size: 12px; }
  .count { color: #656d76; font-size: 12px; margin-bottom: 0.4rem; }
  .table-wrap { overflow-x: auto; border: 1px solid #e6e6e6; border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.45rem 0.65rem; border-bottom: 1px solid #e6e6e6; vertical-align: middle; white-space: nowrap; }
  th { font-size: 11px; font-weight: 600; color: #656d76; background: #fff; }
  td:nth-child(2) { white-space: normal; min-width: 12rem; }
  tr:last-child td { border-bottom: 0; }
  tbody tr { position: relative; }
  tbody tr:hover { background: #fafafa; }
  a.rowlink::after { content: ""; position: absolute; inset: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .when { color: #656d76; }
  .empty { color: #656d76; padding: 1rem 1.15rem; }
  .note-line { color: #656d76; padding: 0.75rem 1.15rem; }
  .banner { color: #656d76; padding: 0.75rem 0; }
  .banner { padding: 0.6rem 0.9rem; border-bottom: 1px solid #e6e6e6; }
  .topbar { display: flex; align-items: center; gap: 0.75rem; min-height: 48px; padding: 0.4rem 0.9rem; border-bottom: 1px solid #e6e6e6; }
  .back { border: 1px solid #e6e6e6; border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 12px; }
  .pr { font-weight: 600; }
  .topbar h1 { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
  .columns { display: grid; grid-template-columns: 220px minmax(0, 1fr) 380px; width: 100%; height: calc(100vh - 48px); }
  .col { min-height: 0; min-width: 0; overflow: auto; }
  .rail { overflow-x: hidden; overflow-y: auto; }
  .tree, .diff { border-right: 1px solid #e6e6e6; }
  .col-label, h2 { font-size: 11px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; color: #656d76; padding: 0.75rem 0.85rem 0.35rem; }
  .nodes { list-style: none; margin: 0; padding: 0 0 0.25rem; }
  .nodes .nodes { padding-left: 0.85rem; }
  .tree a, .dirname { display: flex; gap: 0.4rem; align-items: center; padding: 0.15rem 0.85rem; }
  .dirname { color: #656d76; }
  .tree .mark { width: 0.9rem; color: #656d76; font-size: 11px; }
  .file:target { background: #fafafa; }
  .file-head { display: flex; gap: 0.5rem; align-items: center; padding: 0.55rem 0.9rem; border-bottom: 1px solid #e6e6e6; position: sticky; top: 0; background: #fff; }
  .path { font-weight: 600; }
  .patch { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .line { display: grid; grid-template-columns: 3rem 3rem 1rem minmax(0, 1fr); gap: 0.35rem; padding: 0 0.9rem 0 0; }
  .line code { white-space: pre-wrap; overflow-wrap: anywhere; }
  .gutter { text-align: right; color: #8b949e; }
  .line .mark { color: #8b949e; }
  .line.sev-0 { box-shadow: inset 2px 0 0 #cf222e; }
  .line.sev-1 { box-shadow: inset 2px 0 0 #bc4c00; }
  .line.sev-2 { box-shadow: inset 2px 0 0 #9a6700; }
  .line.sev-3 { box-shadow: inset 2px 0 0 #57606a; }
  .hunk { color: #656d76; background: #f6f8fa; padding: 0.15rem 0.9rem; }
  .comment { margin: 0.45rem 0.9rem 0.7rem 4.5rem; border: 1px solid #e6e6e6; border-radius: 8px; padding: 0.55rem 0.7rem 0.65rem; }
  .comment.p0 { border-left: 2px solid #cf222e; }
  .comment.p1 { border-left: 2px solid #bc4c00; }
  .comment.p2 { border-left: 2px solid #9a6700; }
  .comment.p3 { border-left: 2px solid #57606a; }
  .comment header { display: flex; gap: 0.35rem; align-items: center; margin-bottom: 0.3rem; }
  .comment h3 { font-size: 13px; font-weight: 650; }
  .comment p { margin-top: 0.35rem; }
  .trigger .k, .k { color: #656d76; margin-right: 0.35rem; }
  .suggestion { margin: 0.45rem 0 0; padding: 0.45rem 0.55rem; border: 1px solid #e6e6e6; border-radius: 6px; background: #fff; white-space: pre-wrap; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .unanchored { padding-bottom: 0.5rem; }
  .unanchored .comment { margin-left: 0.9rem; }
  .rail section + section { border-top: 1px solid #e6e6e6; }
  .rail .badge, .rail .verdict, .rail .reason { margin: 0 0.85rem 0.45rem; }
  .rail .status-note { margin: 0 0.85rem 0.85rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .counts, .settings { display: grid; grid-template-columns: 9.5rem minmax(0, 1fr); gap: 0.28rem 0.6rem; margin: 0.6rem 0.85rem 0.8rem; }
  .counts dt, .settings dt { color: #656d76; }
  .settings dd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .findings, .checked { list-style: none; margin: 0.4rem 0 0.8rem; padding: 0; }
  .findings a { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: baseline; padding: 0.35rem 0.85rem; border-top: 1px solid #f0f0f0; }
  .where { color: #656d76; font-size: 11px; }
  .checked li { padding: 0.15rem 0.85rem; color: #656d76; }
  .login-wrap { min-height: 100vh; width: 100%; display: grid; place-items: center; padding: 1.5rem; }
  form.login { width: min(100%, 22rem); display: flex; flex-direction: column; gap: 0.75rem; border: 1px solid #e6e6e6; border-radius: 8px; padding: 1.25rem; }
  form.login h1 { font-size: 16px; font-weight: 650; }
  form.login label { display: flex; flex-direction: column; gap: 0.3rem; color: #656d76; font-size: 11px; }
  form.login input { width: 100%; }
  .login-error { color: #cf222e; }
  @media (max-width: 960px) {
    .columns { grid-template-columns: 1fr; height: auto; }
    .tree, .diff { border-right: 0; border-bottom: 1px solid #e6e6e6; }
    .tree, .rail { max-height: none; }
    .topbar { flex-wrap: wrap; height: auto; }
    .topbar h1 { flex-basis: 100%; order: 5; }
  }
`;
