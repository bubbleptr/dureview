import { useEffect, type ReactNode } from "react";
import type { ShellStatus } from "./app-shell.js";
import type { StatsPageModel, StatsRankRow } from "../ui/stats-model.js";
import { AppShell } from "./app-shell.js";
import { ClientChart } from "./client-chart.js";
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

export function StatsPage({ model, status = null }: { model: StatsPageModel; status?: ShellStatus | null }) {
  return (
    <AppShell
      current="stats"
      title="Statistics"
      status={status}
      form={{ method: "get", action: "/ui/stats" }}
      filters={
        <>
          <Label className="flex flex-col gap-1">
            Time range
            <NativeSelect name="range" defaultValue={model.form.range} className="h-8 text-xs" onChange={submitForm}>
              {RANGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label className="flex min-w-40 flex-col gap-1">
            Repository
            <NativeSelect name="repo" defaultValue={model.form.repo} className="h-8 w-44 text-xs" onChange={submitForm}>
              <option value="">All repositories</option>
              {model.repos.map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <TimezoneField tz={model.form.tz} />
          <Button type="submit" size="sm">
            Apply
          </Button>
          {model.filtered ? (
            <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/ui/stats">
              Clear
            </a>
          ) : null}
        </>
      }
    >
      <p className="text-sm text-muted-foreground">Review volume, duration, findings, and model tokens.</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {model.cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="p-4">
              <CardDescription>{card.label}</CardDescription>
              <p className="font-mono text-2xl font-semibold tabular-nums">{card.value}</p>
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
    </AppShell>
  );
}

function submitForm(event: { currentTarget: { form: HTMLFormElement | null } }): void {
  event.currentTarget.form?.requestSubmit();
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
