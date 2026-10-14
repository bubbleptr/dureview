import { homeStatsSearches } from "./home-query.js";
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
  const stats = homeStatsSearches(search);
  const [week, day] = await Promise.all([
    getStats({ data: { search: stats.week, next } }),
    getStats({ data: { search: stats.day, next } }),
  ]);
  return {
    list,
    week: week.kind === "stats" ? week.model : null,
    day: day.kind === "stats" ? day.model : null,
  };
}
