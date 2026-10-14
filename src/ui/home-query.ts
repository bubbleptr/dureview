import { statsRepo, timezoneOffsetMinutes } from "./stats-query.js";

/** Stats searches for the overview cards. The list's `since` does not change these windows. */
export function homeStatsSearches(search: string): { week: string; day: string } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const repo = statsRepo(params.get("repo"));
  const tz = timezoneOffsetMinutes(params.get("tz"));
  const repoQuery = repo ? `&repo=${encodeURIComponent(repo)}` : "";
  const tzQuery = `&tz=${tz}`;
  return {
    week: `range=7d${repoQuery}${tzQuery}`,
    day: `range=24h${repoQuery}${tzQuery}`,
  };
}
