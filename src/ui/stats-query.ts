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
  const repo = statsRepo(params.get("repo"));
  const tz = timezoneOffsetMinutes(params.get("tz"));
  return {
    form: { range, repo, tz },
    query: { repo, since: sinceFor(range, now), tzOffsetMinutes: tz },
  };
}

export function statsFormIsFiltered(form: StatsForm): boolean {
  return form.range !== "7d" || form.repo !== "";
}

export function statsRepo(raw: string | null | undefined): string {
  const repo = raw?.trim() ?? "";
  return REPO.test(repo) ? repo : "";
}

/** Minutes east of UTC, clamped to ±14 hours. Missing or invalid values stay at UTC. */
export function timezoneOffsetMinutes(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return 0;
  const tz = Number(raw);
  if (!Number.isFinite(tz)) return 0;
  return Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(tz)));
}

function sinceFor(range: StatsRange, now: number): string | null {
  if (range === "all") return null;
  const hour = 60 * 60 * 1000;
  if (range === "24h") return new Date(now - 24 * hour).toISOString();
  if (range === "7d") return new Date(now - 7 * 24 * hour).toISOString();
  return new Date(now - 30 * 24 * hour).toISOString();
}
