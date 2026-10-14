import type { ReviewListModel, ReviewRowView } from "../ui/list-model.js";
import { omittedUsageNote, overviewTokenStat, tokenTrendMessage } from "../ui/overview-tokens.js";
import type { StatsPageModel } from "../ui/stats-model.js";
import { ClientChart } from "./client-chart.js";
import { FigureBlock, StatStrip, TrendDataTable } from "./stat-strip.js";

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
  const usage = week?.tokenUsage ?? null;
  const empty = tokenTrendMessage(usage, (trend?.points.length ?? 0) > 0);
  const omitted = omittedUsageNote(usage);
  return (
    <>
      <StatStrip stats={cards} />
      <FigureBlock
        title="Tokens over 7 days"
        caption="Each line is one model. Days use this browser's time zone. The chart shows token volume, not cost or review quality."
      >
        {empty ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : trend ? (
          <>
            <ClientChart className="h-72" render={(charts) => <charts.TokenTrendChart trend={trend} />} />
            <TrendDataTable trend={trend} />
            {omitted ? <p className="text-sm text-muted-foreground">{omitted}</p> : null}
          </>
        ) : null}
      </FigureBlock>
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
  const tokens = overviewTokenStat(week?.tokenUsage ?? null);
  if (todayCard && weekCounts && p0 !== undefined && p1 !== undefined && week) {
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
      { label: "Token usage", value: tokens.value, detail: tokens.detail },
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

function numeric(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.max(0, Math.round(value)));
}

