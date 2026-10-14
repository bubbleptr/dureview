import type { StatsQuery } from "../review/stats.js";

const RANGES = new Set(["24h", "7d", "30d", "all"]);
const REPO = /^(?!.*\.\.)[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export type StatsRange = "24h" | "7d" | "30d" | "all";

export type StatsForm = {
  range: StatsRange;
  repo: string;
  /** Minutes east of UTC. Zero until the browser reports its offset. */
  tz: number;
};

export function statsQueryFromSearch(
  params: URLSearchParams,
  now = Date.now(),
): { query: StatsQuery; form: StatsForm } {
  const rangeRaw = params.get("range")?.trim() ?? "";
  const range: StatsRange = RANGES.has(rangeRaw) ? (rangeRaw as StatsRange) : "7d";
  const repoRaw = params.get("repo")?.trim() ?? "";
  const repo = REPO.test(repoRaw) ? repoRaw : "";
  const tzRaw = Number(params.get("tz"));
  const tz = Number.isFinite(tzRaw) ? Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(tzRaw))) : 0;
  return {
    form: { range, repo, tz },
    query: { repo, since: sinceFor(range, now), tzOffsetMinutes: tz },
  };
}

export function statsFormIsFiltered(form: StatsForm): boolean {
  return form.range !== "7d" || form.repo !== "";
}

function sinceFor(range: StatsRange, now: number): string | null {
  if (range === "all") return null;
  const hour = 60 * 60 * 1000;
  if (range === "24h") return new Date(now - 24 * hour).toISOString();
  if (range === "7d") return new Date(now - 7 * 24 * hour).toISOString();
  return new Date(now - 30 * 24 * hour).toISOString();
}
