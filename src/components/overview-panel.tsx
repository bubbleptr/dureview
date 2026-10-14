import type { ReviewListModel, ReviewRowView } from "../ui/list-model.js";
import type { StatsPageModel } from "../ui/stats-model.js";
import { ClientChart } from "./client-chart.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";

export function OverviewPanel({
  model,
  week,
  day,
}: {
  model: ReviewListModel;
  week?: StatsPageModel | null;
  day?: StatsPageModel | null;
}) {
  const cards = overviewCards(model.reviews, week ?? null, day ?? null);
  const trend = week?.trend;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="gap-1 p-4">
              <CardDescription>{card.label}</CardDescription>
              <p className="font-mono text-2xl font-semibold tracking-tight tabular-nums">{card.value}</p>
              <p className="text-xs text-muted-foreground">{card.detail}</p>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader className="p-4">
          <CardTitle>7-day trend</CardTitle>
          <CardDescription>Token usage by model. Days follow this browser's timezone.</CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {!trend || trend.points.length === 0 ? (
            <p className="text-sm text-muted-foreground">No token usage in the last 7 days.</p>
          ) : (
            <ClientChart render={(charts) => <charts.TokenTrendChart trend={trend} />} />
          )}
        </CardContent>
      </Card>
    </>
  );
}

function overviewCards(
  rows: ReviewRowView[],
  week: StatsPageModel | null,
  day: StatsPageModel | null,
): Array<{ label: string; value: string; detail: string }> {
  const todayCard = day?.cards.find((card) => card.label === "Reviews");
  const weekCard = week?.cards.find((card) => card.label === "Reviews");
  const weekCounts = weekCard ? parseRunDetail(weekCard.detail) : null;
  const p0 = week?.priorities.find((row) => row.name === "P0")?.count;
  const p1 = week?.priorities.find((row) => row.name === "P1")?.count;
  const tokens = week ? sumTokens(week.trend) : null;
  if (todayCard && weekCounts && p0 !== undefined && p1 !== undefined && tokens !== null) {
    const finished = weekCounts.completed + weekCounts.failed;
    const rate = finished === 0 ? "—" : `${Math.round((weekCounts.completed / finished) * 100)}%`;
    return [
      { label: "Reviews today", value: todayCard.value, detail: "Last 24 hours" },
      {
        label: "Success rate",
        value: rate,
        detail: finished === 0 ? "No finished reviews" : `${weekCounts.completed} of ${finished} finished · 7 days`,
      },
      { label: "P0 / P1", value: `${formatCount(p0)} / ${formatCount(p1)}`, detail: "Last 7 days" },
      { label: "Token usage", value: formatTokens(tokens), detail: "Last 7 days" },
    ];
  }
  return fallbackCards(rows);
}

function fallbackCards(rows: ReviewRowView[]): Array<{ label: string; value: string; detail: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = rows.filter((row) => row.whenIso.startsWith(today)).length;
  const finished = rows.filter((row) => row.resultKind !== "running");
  const ok = finished.filter((row) => row.resultKind !== "error").length;
  const rate = finished.length === 0 ? "—" : `${Math.round((ok / finished.length) * 100)}%`;
  const p0 = rows.reduce((sum, row) => sum + numeric(row.p0), 0);
  const p1 = rows.reduce((sum, row) => sum + numeric(row.p1), 0);
  return [
    { label: "Reviews today", value: formatCount(todayCount), detail: "Last 24 hours" },
    { label: "Success rate", value: rate, detail: finished.length === 0 ? "No finished reviews" : `${ok} of ${finished.length} finished` },
    { label: "P0 / P1", value: `${formatCount(p0)} / ${formatCount(p1)}`, detail: "In this list" },
    { label: "Token usage", value: "—", detail: "Not recorded on this page" },
  ];
}

function parseRunDetail(detail: string): { completed: number; failed: number; running: number } | null {
  const match = /^([\d,]+) completed · ([\d,]+) failed · ([\d,]+) running/.exec(detail);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    completed: Number(match[1].replaceAll(",", "")),
    failed: Number(match[2].replaceAll(",", "")),
    running: Number(match[3].replaceAll(",", "")),
  };
}

function sumTokens(trend: StatsPageModel["trend"]): number {
  let sum = 0;
  for (const point of trend.points) {
    for (const model of trend.models) {
      const value = point[model];
      if (typeof value === "number") sum += value;
    }
  }
  return sum;
}

function numeric(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}k`;
  return formatCount(value);
}

function trim(value: number): string {
  const digits = Math.abs(value) >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}
