import type { StatsSnapshot } from "../review/stats.js";
import type { DureviewService } from "../service.js";
import { fill, formatCost, formatCount, formatDayLabel, formatTokens } from "./format.js";
import type { Locale } from "./locale.js";
import { messages } from "./messages.js";
import { formatDuration } from "./page.js";
import type { StatsPageModel, StatsRankRow, StatsTrendPoint } from "./stats-model.js";
import { statsFormIsFiltered, statsQueryFromSearch } from "./stats-query.js";

/** Build the statistics page from SQL aggregates. Callers enforce the UI token first. */
export async function buildStatsPage(
  service: DureviewService,
  searchParams: URLSearchParams,
  now = Date.now(),
  locale: Locale = "en",
): Promise<StatsPageModel> {
  const parsed = statsQueryFromSearch(searchParams, now);
  const snapshot = await service.statsForUi(parsed.query);
  const repos = new Set(snapshot.repos);
  if (parsed.form.repo) repos.add(parsed.form.repo);
  return {
    form: parsed.form,
    repos: [...repos].sort((left, right) => left.localeCompare(right)),
    filtered: statsFormIsFiltered(parsed.form),
    empty: snapshot.reviews === 0,
    cards: cards(snapshot, locale),
    trend: trend(snapshot, locale),
    priorities: priorityBars(snapshot),
    types: typeBars(snapshot),
    categories: shareBars(
      snapshot.categories.map((row) => ({ name: labelize(row.category), count: row.count })),
    ),
    verdicts: verdictBars(snapshot),
    failures: shareBars(snapshot.failures.map((row) => ({ name: clip(row.reason, 80), count: row.count }))),
    expensive: snapshot.expensive.map((row) => rank(`${row.repo} #${row.number}`, row.title, row.reviews, null, row.totalTokens, row.costUsd, locale)),
    topRepos: snapshot.topRepos.map((row) => rank(row.repo, "", row.reviews, row.findings, null, null, locale)),
    topPulls: snapshot.topPulls.map((row) =>
      rank(`${row.repo} #${row.number}`, row.title, row.reviews, row.findings, null, null, locale),
    ),
    usageNote: usageNote(snapshot, locale),
    tokenUsage: tokenUsage(snapshot),
  };
}

function cards(snapshot: StatsSnapshot, locale: Locale): StatsPageModel["cards"] {
  const copy = messages[locale].overview.cards;
  const findings = snapshot.priorities.p0 + snapshot.priorities.p1 + snapshot.priorities.p2 + snapshot.priorities.p3;
  const priorityDetail = `P0 ${formatCount(snapshot.priorities.p0, locale)} · P1 ${formatCount(snapshot.priorities.p1, locale)} · P2 ${formatCount(snapshot.priorities.p2, locale)} · P3 ${formatCount(snapshot.priorities.p3, locale)}`;
  return [
    {
      label: copy.reviews,
      value: formatCount(snapshot.reviews, locale),
      detail: fill(copy.reviewsDetail, {
        completed: formatCount(snapshot.completed, locale),
        failed: formatCount(snapshot.failed, locale),
        running: formatCount(snapshot.running, locale),
      }),
    },
    {
      label: copy.avgDuration,
      value: formatDuration(snapshot.avgDurationMs),
      detail: snapshot.durationSamples === 0 ? copy.noFinished : fill(copy.finished, { count: formatCount(snapshot.durationSamples, locale) }),
    },
    {
      label: copy.p95,
      value: formatDuration(snapshot.p95DurationMs),
      detail: copy.finishedOnly,
    },
    {
      label: copy.findings,
      value: formatCount(findings, locale),
      detail:
        snapshot.priorities.unknownReviews > 0
          ? fill(copy.withoutBreakdown, { priority: priorityDetail, count: formatCount(snapshot.priorities.unknownReviews, locale) })
          : priorityDetail,
    },
    {
      label: copy.avgTokens,
      value: snapshot.tokens.avgTotal === null ? "—" : formatTokens(snapshot.tokens.avgTotal, locale),
      detail:
        snapshot.tokens.knownReviews === 0
          ? snapshot.reviews === 0
            ? copy.noReviews
            : fill(copy.unknownTokens, { count: formatCount(snapshot.tokens.unknownReviews, locale) })
          : fill(copy.tokenDetail, {
              input: formatTokens(snapshot.tokens.avgInput ?? 0, locale),
              output: formatTokens(snapshot.tokens.avgOutput ?? 0, locale),
              known: formatCount(snapshot.tokens.knownReviews, locale),
              total: formatCount(snapshot.reviews, locale),
            }),
    },
    {
      label: copy.cost,
      value: snapshot.tokens.totalCostUsd === null ? "—" : formatCost(snapshot.tokens.totalCostUsd, locale),
      detail:
        snapshot.tokens.costKnownReviews === 0
          ? copy.noCost
          : fill(copy.costDetail, { count: formatCount(snapshot.tokens.costKnownReviews, locale) }),
    },
  ];
}

function trend(snapshot: StatsSnapshot, locale: Locale): StatsPageModel["trend"] {
  const models = [...new Set(snapshot.trend.map((row) => row.model))].sort((left, right) => left.localeCompare(right));
  const days = [...new Set(snapshot.trend.map((row) => row.day))].sort();
  const points: StatsTrendPoint[] = days.map((day) => {
    const point: StatsTrendPoint = { day, label: formatDayLabel(day, locale) };
    for (const model of models) point[model] = null;
    return point;
  });
  const byDay = new Map(points.map((point) => [point.day, point]));
  for (const row of snapshot.trend) {
    const point = byDay.get(row.day);
    if (!point) continue;
    point[row.model] = row.totalTokens;
  }
  return { models, points };
}

function priorityBars(snapshot: StatsSnapshot): StatsPageModel["priorities"] {
  const rows = [
    { name: "P0", count: snapshot.priorities.p0 },
    { name: "P1", count: snapshot.priorities.p1 },
    { name: "P2", count: snapshot.priorities.p2 },
    { name: "P3", count: snapshot.priorities.p3 },
  ];
  return shareBars(rows);
}

function typeBars(snapshot: StatsSnapshot): StatsPageModel["types"] {
  const count = (type: string) => snapshot.types.find((row) => row.type === type)?.count ?? 0;
  const rows = [
    { name: "Bug", count: count("bug") },
    { name: "Flag", count: count("flag") },
    { name: "Security", count: count("security") },
  ];
  const unknown = count("unknown");
  if (unknown > 0) rows.push({ name: "Unknown", count: unknown });
  return shareBars(rows);
}

function verdictBars(snapshot: StatsSnapshot): StatsPageModel["verdicts"] {
  return shareBars([
    { name: "Block", count: snapshot.verdicts.block },
    { name: "Fix recommended", count: snapshot.verdicts.fixRecommended },
    { name: "Clean", count: snapshot.verdicts.clean },
    { name: "Unknown", count: snapshot.verdicts.unknown },
  ]).filter((row) => row.name !== "Unknown" || row.count > 0);
}

function shareBars(rows: Array<{ name: string; count: number }>): StatsPageModel["priorities"] {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return rows.map((row) => ({
    name: row.name,
    count: row.count,
    share: total <= 0 ? "0%" : `${Math.round((row.count / total) * 100)}%`,
  }));
}

function rank(
  label: string,
  title: string,
  reviews: number,
  findings: number | null,
  tokens: number | null,
  cost: number | null,
  locale: Locale,
): StatsRankRow {
  const text = title ? `${label} · ${title}` : label;
  return {
    label: clip(text, 120),
    href: "",
    reviews: formatCount(reviews, locale),
    findings: findings === null ? "" : formatCount(findings, locale),
    tokens: tokens === null ? "" : formatTokens(tokens, locale),
    cost: cost === null ? (tokens === null ? "" : "—") : formatCost(cost, locale),
  };
}

function tokenUsage(snapshot: StatsSnapshot): StatsPageModel["tokenUsage"] {
  const knownReviews = snapshot.tokens.knownReviews;
  const unknownReviews = snapshot.tokens.unknownReviews;
  if (knownReviews === 0) return { total: null, knownReviews, unknownReviews };
  return {
    total: snapshot.tokens.totalInput + snapshot.tokens.totalOutput + (snapshot.tokens.totalCacheRead ?? 0),
    knownReviews,
    unknownReviews,
  };
}

function usageNote(snapshot: StatsSnapshot, locale: Locale): string {
  const copy = messages[locale].overview;
  if (snapshot.tokens.knownReviews === 0) return copy.usageNoteUnknown;
  const unknown =
    snapshot.tokens.unknownReviews > 0
      ? ` ${fill(snapshot.tokens.unknownReviews === 1 ? copy.usageOmittedOne : copy.usageOmittedMany, { count: formatCount(snapshot.tokens.unknownReviews, locale) })}`
      : "";
  return `${copy.usageNoteKnown}${unknown}`;
}

function labelize(value: string): string {
  return value.replaceAll("_", " ");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
