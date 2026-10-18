import type { StatsSnapshot } from "../review/stats.js";
import type { DureviewService } from "../service.js";
import { fill, formatCost, formatCount, formatDayLabel, formatPercent, formatTokens } from "./format.js";
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
    adoptionCards: adoptionCards(snapshot, locale),
    unclassifiedNote: unclassifiedNote(snapshot, locale),
    adoptionTrend: adoptionTrend(snapshot, locale),
    recurring: recurring(snapshot, locale),
    hotspots: hotspots(snapshot, locale),
    speedCards: speedCards(snapshot, locale),
    speed: speedPoints(snapshot),
    medianMinutes: snapshot.medianDurationMs === null ? null : durationMinutes(snapshot.medianDurationMs),
    outlier: outlierNote(snapshot, locale),
    trend: trend(snapshot, locale),
    priorities: priorityBars(snapshot),
    types: typeBars(snapshot),
    categories: shareBars(
      snapshot.categories.map((row) => ({ name: labelize(row.category), count: row.count })),
    ),
    verdicts: verdictBars(snapshot),
    failures: shareBars(snapshot.failures.map((row) => ({ name: clip(row.reason, 80), count: row.count }))),
    failedReviews: snapshot.failed,
    expensive: snapshot.expensive.map((row) => rank(`${row.repo} #${row.number}`, row.title, row.reviews, null, row.totalTokens, row.costUsd, locale)),
    topRepos: snapshot.topRepos.map((row) => rank(row.repo, "", row.reviews, row.findings, null, null, locale)),
    topPulls: snapshot.topPulls.map((row) =>
      rank(`${row.repo} #${row.number}`, row.title, row.reviews, row.findings, null, null, locale),
    ),
    usageNote: usageNote(snapshot, locale),
    tokenUsage: tokenUsage(snapshot),
  };
}

function adoptionCards(snapshot: StatsSnapshot, locale: Locale): StatsPageModel["adoptionCards"] {
  const copy = messages[locale].overview;
  const adopted = snapshot.adoption.adopted;
  const ignored = snapshot.adoption.ignored;
  const pending = snapshot.adoption.pending;
  const decided = adopted + ignored;
  const rate = decided === 0 ? null : adopted / decided;
  return [
    {
      label: copy.adoptionRate,
      value: formatPercent(rate, locale),
      detail: decided === 0 ? copy.noDecided : fill(copy.adoptionRateDetail, { adopted: formatCount(adopted, locale), ignored: formatCount(ignored, locale) }),
    },
    { label: copy.adopted, value: formatCount(adopted, locale), detail: copy.adoptedDetail },
    { label: copy.ignored, value: formatCount(ignored, locale), detail: copy.ignoredDetail },
    { label: copy.pending, value: formatCount(pending, locale), detail: copy.pendingDetail },
  ];
}

function unclassifiedNote(snapshot: StatsSnapshot, locale: Locale): string | null {
  const count = snapshot.adoption.unclassified;
  if (count < 1) return null;
  return fill(messages[locale].overview.unclassifiedNote, { count: formatCount(count, locale) });
}

function adoptionTrend(snapshot: StatsSnapshot, locale: Locale): StatsPageModel["adoptionTrend"] {
  return snapshot.adoptionTrend.map((row) => {
    const decided = row.adopted + row.ignored;
    const rate = decided === 0 ? 0 : Math.round((row.adopted / decided) * 100);
    return { day: row.day, label: formatDayLabel(row.day, locale), adopted: row.adopted, ignored: row.ignored, rate };
  });
}

function recurring(snapshot: StatsSnapshot, locale: Locale): StatsPageModel["recurring"] {
  return snapshot.recurring.map((group) => ({
    category: group.category,
    count: formatCount(group.count, locale),
    titles: group.titles.map((title) => ({ title: clip(title.title, 80), count: formatCount(title.count, locale) })),
  }));
}

function hotspots(snapshot: StatsSnapshot, locale: Locale): StatsPageModel["hotspots"] {
  return snapshot.hotspots.map((row) => ({
    repo: row.repo,
    directory: row.directory,
    count: formatCount(row.count, locale),
  }));
}

function speedCards(snapshot: StatsSnapshot, locale: Locale): StatsPageModel["speedCards"] {
  const copy = messages[locale].overview.cards;
  return [
    {
      label: copy.avgDuration,
      value: formatDuration(snapshot.avgDurationMs),
      detail: snapshot.durationSamples === 0 ? copy.noFinished : fill(copy.finished, { count: formatCount(snapshot.durationSamples, locale) }),
    },
    { label: copy.p95, value: formatDuration(snapshot.p95DurationMs), detail: copy.finishedOnly },
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

function speedPoints(snapshot: StatsSnapshot): StatsPageModel["speed"] {
  const flagged = new Set(snapshot.durations.filter((row) => row.outlier).map((row) => row.taskId));
  const points = snapshot.durations.map((row) => ({
    id: row.taskId,
    label: `${row.repo.split("/")[1] || row.repo} #${row.number}`,
    detail: row.title ? `${row.repo} #${row.number} · ${clip(row.title, 80)}` : `${row.repo} #${row.number}`,
    minutes: durationMinutes(row.durationMs),
    duration: formatDuration(row.durationMs),
  }));
  const recent = points.slice(-48);
  const seen = new Set(recent.map((point) => point.id));
  return [...points.filter((point) => flagged.has(point.id) && !seen.has(point.id)), ...recent];
}

function outlierNote(snapshot: StatsSnapshot, locale: Locale): StatsPageModel["outlier"] {
  const outliers = snapshot.durations.filter((row) => row.outlier).toSorted((left, right) => right.durationMs - left.durationMs);
  const longest = outliers[0];
  if (!longest || snapshot.medianDurationMs === null) return null;
  const copy = messages[locale].overview;
  const label = `${longest.repo} #${longest.number}`;
  const duration = formatDuration(longest.durationMs);
  const headline =
    outliers.length === 1
      ? fill(copy.outlierOne, { label, duration })
      : fill(copy.outlierMany, { count: formatCount(outliers.length, locale), label, duration });
  return { headline, detail: fill(copy.outlierRule, { median: formatDuration(snapshot.medianDurationMs) }) };
}

function durationMinutes(ms: number): number {
  return Math.round((ms / 60_000) * 100) / 100;
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
