import type { ReviewFilter, ReviewResultKind } from "../review/archive.js";

const RESULTS = new Set<ReviewResultKind>(["pass", "suggest", "blocker", "error", "running"]);
const SINCE = new Set(["24h", "7d", "30d"]);
const REPO = /^(?!.*\.\.)[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ReviewFormState = {
  repo: string;
  result: "" | ReviewResultKind;
  since: "" | "24h" | "7d" | "30d";
  from: string;
  to: string;
  q: string;
};

export function reviewFilterFromSearch(params: URLSearchParams, now = Date.now()): { filter: ReviewFilter; form: ReviewFormState } {
  const repo = params.get("repo")?.trim() ?? "";
  const resultRaw = params.get("result")?.trim() ?? "";
  const sinceRaw = params.get("since")?.trim() ?? "";
  const from = dayOrEmpty(params.get("from"));
  const to = dayOrEmpty(params.get("to"));
  const q = (params.get("q") ?? "").replaceAll("\0", "").trim().slice(0, 200);
  const form: ReviewFormState = {
    repo: REPO.test(repo) ? repo : "",
    result: RESULTS.has(resultRaw as ReviewResultKind) ? (resultRaw as ReviewResultKind) : "",
    since: SINCE.has(sinceRaw) ? (sinceRaw as ReviewFormState["since"]) : "",
    from,
    to,
    q,
  };
  let sinceMs: number | null = null;
  if (form.since === "24h") sinceMs = now - 24 * 60 * 60 * 1000;
  if (form.since === "7d") sinceMs = now - 7 * 24 * 60 * 60 * 1000;
  if (form.since === "30d") sinceMs = now - 30 * 24 * 60 * 60 * 1000;
  const fromMs = form.from ? Date.parse(`${form.from}T00:00:00.000Z`) : null;
  if (fromMs !== null && (sinceMs === null || fromMs > sinceMs)) sinceMs = fromMs;
  const untilMs = form.to ? Date.parse(`${form.to}T23:59:59.999Z`) : null;
  return {
    form,
    filter: {
      repo: form.repo,
      result: form.result,
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      until: untilMs === null || Number.isNaN(untilMs) ? null : new Date(untilMs).toISOString(),
      q: form.q,
    },
  };
}

export function formIsFiltered(form: ReviewFormState): boolean {
  return Boolean(form.repo || form.result || form.since || form.from || form.to || form.q);
}

function dayOrEmpty(value: string | null): string {
  const trimmed = value?.trim() ?? "";
  const match = DAY.exec(trimmed);
  if (!match?.[1] || !match[2] || !match[3]) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return trimmed;
}
