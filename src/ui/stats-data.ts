import type { StatsSnapshot } from "../review/stats.js";
import type { DureviewService } from "../service.js";
import { formatDuration } from "./page.js";
import type { StatsPageModel, StatsRankRow, StatsTrendPoint } from "./stats-model.js";
import { statsFormIsFiltered, statsQueryFromSearch } from "./stats-query.js";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Build the statistics page from SQL aggregates. Callers enforce the UI token first. */
export async function buildStatsPage(
  service: DureviewService,
  searchParams: URLSearchParams,
  now = Date.now(),
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
    cards: cards(snapshot),
    trend: trend(snapshot),
    priorities: priorityBars(snapshot),
    categories: shareBars(
      snapshot.categories.map((row) => ({ name: labelize(row.category), count: row.count })),
    ),
    verdicts: verdictBars(snapshot),
    failures: shareBars(snapshot.failures.map((row) => ({ name: clip(row.reason, 80), count: row.count }))),
    expensive: snapshot.expensive.map((row) => rank(`${row.repo} #${row.number}`, row.title, row.reviews, null, row.totalTokens, row.costUsd)),
    topRepos: snapshot.topRepos.map((row) => rank(row.repo, "", row.reviews, row.findings, null, null)),
    topPulls: snapshot.topPulls.map((row) =>
      rank(`${row.repo} #${row.number}`, row.title, row.reviews, row.findings, null, null),
    ),
    usageNote: usageNote(snapshot),
  };
}

function cards(snapshot: StatsSnapshot): StatsPageModel["cards"] {
  const findings = snapshot.priorities.p0 + snapshot.priorities.p1 + snapshot.priorities.p2 + snapshot.priorities.p3;
  const priorityDetail = `P0 ${snapshot.priorities.p0} · P1 ${snapshot.priorities.p1} · P2 ${snapshot.priorities.p2} · P3 ${snapshot.priorities.p3}`;
  return [
    {
      label: "Reviews",
      value: formatCount(snapshot.reviews),
      detail: `${snapshot.completed} completed · ${snapshot.failed} failed · ${snapshot.running} running`,
    },
    {
      label: "Avg duration",
      value: formatDuration(snapshot.avgDurationMs),
      detail: snapshot.durationSamples === 0 ? "No finished reviews" : `${snapshot.durationSamples} finished`,
    },
    {
      label: "P95 duration",
      value: formatDuration(snapshot.p95DurationMs),
      detail: "Finished reviews only",
    },
    {
      label: "Findings",
      value: formatCount(findings),
      detail:
        snapshot.priorities.unknownReviews > 0
          ? `${priorityDetail} · ${snapshot.priorities.unknownReviews} without a breakdown`
          : priorityDetail,
    },
    {
      label: "Avg tokens",
      value: snapshot.tokens.avgTotal === null ? "—" : formatTokens(snapshot.tokens.avgTotal),
      detail:
        snapshot.tokens.knownReviews === 0
          ? snapshot.reviews === 0
            ? "No reviews"
            : `Unknown for ${snapshot.tokens.unknownReviews} reviews`
          : `${formatTokens(snapshot.tokens.avgInput ?? 0)} in · ${formatTokens(snapshot.tokens.avgOutput ?? 0)} out · ${snapshot.tokens.knownReviews} of ${snapshot.reviews}`,
    },
    {
      label: "Est. cost",
      value: snapshot.tokens.totalCostUsd === null ? "—" : formatCost(snapshot.tokens.totalCostUsd),
      detail:
        snapshot.tokens.costKnownReviews === 0
          ? "pi-ai did not report a cost"
          : `${snapshot.tokens.costKnownReviews} reviews · catalog rates`,
    },
  ];
}

function trend(snapshot: StatsSnapshot): StatsPageModel["trend"] {
  const models = [...new Set(snapshot.trend.map((row) => row.model))].sort((left, right) => left.localeCompare(right));
  const days = [...new Set(snapshot.trend.map((row) => row.day))].sort();
  const points: StatsTrendPoint[] = days.map((day) => {
    const point: StatsTrendPoint = { day, label: formatDayLabel(day) };
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
): StatsRankRow {
  const text = title ? `${label} · ${title}` : label;
  return {
    label: clip(text, 120),
    href: "",
    reviews: formatCount(reviews),
    findings: findings === null ? "" : formatCount(findings),
    tokens: tokens === null ? "" : formatTokens(tokens),
    cost: cost === null ? (tokens === null ? "" : "—") : formatCost(cost),
  };
}

function usageNote(snapshot: StatsSnapshot): string {
  if (snapshot.tokens.knownReviews === 0) {
    return "Token totals are unknown for every review in this range. Older runs were stored before usage was captured, so they are left blank instead of counted as zero.";
  }
  const unknown =
    snapshot.tokens.unknownReviews > 0
      ? ` ${snapshot.tokens.unknownReviews} ${snapshot.tokens.unknownReviews === 1 ? "review has" : "reviews have"} no usage and ${snapshot.tokens.unknownReviews === 1 ? "is" : "are"} omitted from the trend.`
      : "";
  return `Daily totals use this browser's timezone. Each point is input + output + cache-read tokens. Reasoning tokens are already inside output.${unknown}`;
}

function formatDayLabel(day: string): string {
  const match = DAY.exec(day);
  if (!match?.[1] || !match[2] || !match[3]) return day;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trimNumber(value / 1_000)}k`;
  return formatCount(value);
}

function trimNumber(value: number): string {
  const digits = Math.abs(value) >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}

function formatCost(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "$0";
  if (abs < 0.01) return `$${value.toFixed(4)}`;
  if (abs < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function labelize(value: string): string {
  return value.replaceAll("_", " ");
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
