import { useEffect, useState, type ReactNode } from "react";
import type { StatsPageModel, StatsRankRow } from "../ui/stats-model.js";
import { UiNav } from "./ui-nav.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Label } from "./ui/label.js";
import { NativeSelect } from "./ui/native-select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

const RANGES: Array<[string, string]> = [
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["all", "All time"],
];

type ChartsModule = typeof import("./stats-charts.js");

export function StatsPage({ model }: { model: StatsPageModel }) {
  return (
    <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-4 p-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="flex flex-col gap-1">
            <CardTitle>Statistics</CardTitle>
            <CardDescription>Review volume, duration, findings, and model tokens.</CardDescription>
          </div>
          <UiNav current="stats" />
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-3" method="get" action="/ui/stats">
            <Label className="flex flex-col gap-1">
              Time range
              <NativeSelect name="range" defaultValue={model.form.range}>
                {RANGES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className="flex min-w-48 flex-col gap-1">
              Repository
              <NativeSelect name="repo" defaultValue={model.form.repo}>
                <option value="">All repositories</option>
                {model.repos.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <TimezoneField tz={model.form.tz} />
            <Button type="submit">Apply</Button>
            {model.filtered ? (
              <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/ui/stats">
                Clear
              </a>
            ) : null}
          </form>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {model.cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="p-4">
              <CardDescription>{card.label}</CardDescription>
              <p className="text-2xl font-semibold tabular-nums">{card.value}</p>
              <p className="text-xs text-muted-foreground">{card.detail}</p>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Tokens by day</CardTitle>
          <CardDescription>Split by model. Days are in your local timezone.</CardDescription>
        </CardHeader>
        <CardContent>
          {model.trend.points.length === 0 ? (
            <Empty>No token usage in this range.</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.TokenTrendChart trend={model.trend} />} />
          )}
          <p className="mt-3 text-xs text-muted-foreground">{model.usageNote}</p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Priority" description="Share of stored findings">
          <ClientChart render={(charts) => <charts.DistributionChart rows={model.priorities} />} />
        </ChartCard>
        <ChartCard title="Category" description="Includes findings that were not posted">
          {model.categories.length === 0 ? (
            <Empty>No findings in this range.</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DistributionChart rows={model.categories} color="var(--chart-2)" />} />
          )}
        </ChartCard>
        <ChartCard title="Verdict" description="Completed reviews">
          {model.verdicts.every((row) => row.count === 0) ? (
            <Empty>No completed reviews in this range.</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DistributionChart rows={model.verdicts} color="var(--chart-3)" />} />
          )}
        </ChartCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Failure reasons</CardTitle>
          <CardDescription>Grouped by the error recorded for the run.</CardDescription>
        </CardHeader>
        <CardContent>
          {model.failures.length === 0 ? (
            <Empty>No failed reviews in this range.</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.FailureChart rows={model.failures} />} />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <RankCard title="Most expensive pull requests" description="Ranked by pi-ai cost, then by tokens.">
          <RankTable
            rows={model.expensive}
            columns={[
              ["Pull request", "label"],
              ["Reviews", "reviews"],
              ["Tokens", "tokens"],
              ["Cost", "cost"],
            ]}
          />
        </RankCard>
        <RankCard title="Repositories" description="By review count, with finding totals.">
          <RankTable
            rows={model.topRepos}
            columns={[
              ["Repository", "label"],
              ["Reviews", "reviews"],
              ["Findings", "findings"],
            ]}
          />
        </RankCard>
        <RankCard title="Pull requests" description="By finding count.">
          <RankTable
            rows={model.topPulls}
            columns={[
              ["Pull request", "label"],
              ["Reviews", "reviews"],
              ["Findings", "findings"],
            ]}
          />
        </RankCard>
      </div>
    </div>
  );
}

function TimezoneField({ tz }: { tz: number }) {
  useEffect(() => {
    const local = -new Date().getTimezoneOffset();
    if (local === tz) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tz", String(local));
    window.location.replace(url.toString());
  }, [tz]);
  return <input type="hidden" name="tz" defaultValue={tz} />;
}

function ClientChart({ render }: { render: (charts: ChartsModule) => ReactNode }) {
  const [charts, setCharts] = useState<ChartsModule | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("./stats-charts.js").then((module) => {
      if (!cancelled) setCharts(module);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!charts) return <div className="h-56 animate-pulse rounded-md bg-muted/60" />;
  return render(charts);
}

function ChartCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function RankCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function RankTable({
  rows,
  columns,
}: {
  rows: StatsRankRow[];
  columns: Array<[string, keyof StatsRankRow]>;
}) {
  if (rows.length === 0) return <Empty>Nothing in this range.</Empty>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map(([label, key]) => (
            <TableHead key={key} className={key === "label" ? "" : "text-right"}>
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.label}>
            {columns.map(([label, key]) => (
              <TableCell key={label} className={key === "label" ? "max-w-xs whitespace-normal" : "text-right tabular-nums"}>
                {row[key]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
