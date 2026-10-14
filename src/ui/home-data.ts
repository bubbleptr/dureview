import { getReviewList, type ListPayload } from "./list-fn.js";
import { getStats } from "./stats-fn.js";
import type { StatsPageModel } from "./stats-model.js";

export type HomePayload = {
  list: ListPayload;
  week: StatsPageModel | null;
  day: StatsPageModel | null;
};

/** Overview numbers reuse the list and statistics loaders. Filters stay on the list query. */
export async function loadHome(search: string, next: string): Promise<HomePayload> {
  const list = await getReviewList({ data: { search, next } });
  if (list.kind !== "list") return { list, week: null, day: null };
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const repo = params.get("repo")?.trim() ?? "";
  const repoQuery = repo ? `&repo=${encodeURIComponent(repo)}` : "";
  const [week, day] = await Promise.all([
    getStats({ data: { search: `range=7d${repoQuery}`, next } }),
    getStats({ data: { search: `range=24h${repoQuery}`, next } }),
  ]);
  return {
    list,
    week: week.kind === "stats" ? week.model : null,
    day: day.kind === "stats" ? day.model : null,
  };
}
