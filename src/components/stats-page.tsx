import type { ReactNode } from "react";
import type { ShellStatus } from "./app-shell.js";
import { TimezoneField } from "./timezone-field.js";
import type { StatsPageModel, StatsRankRow } from "../ui/stats-model.js";
import { AppShell } from "./app-shell.js";
import { ClientChart } from "./client-chart.js";
import { BarDataTable, FigureBlock, StatStrip, TrendDataTable } from "./stat-strip.js";
import { Button } from "./ui/button.js";
import { Label } from "./ui/label.js";
import { NativeSelect } from "./ui/native-select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

const RANGES: Array<[string, string]> = [
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["all", "All time"],
];

export function OverviewPage({ model, status = null }: { model: StatsPageModel; status?: ShellStatus | null }) {
  return (
    <AppShell current="overview" title="Overview" status={status} form={{ method: "get", action: "/ui" }}>
      <div className="flex flex-col gap-2">
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">Counts and token totals for the selected range.</p>
        <div className="flex flex-wrap items-end gap-3 border-b pb-4">
          <Label className="flex flex-col gap-1 text-xs">
            Time range
            <NativeSelect name="range" defaultValue={model.form.range} className="h-8 text-xs" onChange={submitForm}>
              {RANGES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          </Label>
          <Label className="flex min-w-40 flex-col gap-1 text-xs">
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
            <a className="mb-1 text-sm text-muted-foreground underline-offset-4 hover:underline" href="/ui">
              Clear
            </a>
          ) : null}
        </div>
      </div>

      <StatStrip stats={model.cards} columns={6} />

      <FigureBlock
        title="Tokens by day"
        caption="Each line is one model. Days use this browser's time zone. Length and position show token volume, not cost."
      >
        {model.trend.points.length === 0 ? (
          <Empty>No token usage in this range.</Empty>
        ) : (
          <ClientChart className="h-72" render={(charts) => <charts.TokenTrendChart trend={model.trend} />} />
        )}
        <TrendDataTable trend={model.trend} />
        <p className="text-xs leading-5 text-muted-foreground">{model.usageNote}</p>
      </FigureBlock>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <FigureBlock title="Priority" caption="Share of stored findings. Bar length is the count.">
          <ClientChart render={(charts) => <charts.DistributionChart rows={model.priorities} color="var(--chart-1)" />} />
          <BarDataTable caption="Findings by priority" rows={model.priorities} />
        </FigureBlock>
        <FigureBlock title="Type" caption="Bug, flag, and security. Unknown was stored before types existed. Bar length is the count.">
          {model.types.every((row) => row.count === 0) ? (
            <Empty>No findings in this range.</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DistributionChart rows={model.types} color="var(--chart-1)" />} />
          )}
          <BarDataTable caption="Findings by type" rows={model.types} />
        </FigureBlock>
        <FigureBlock title="Category" caption="Includes findings that were not posted. Bar length is the count.">
          {model.categories.length === 0 ? (
            <Empty>No findings in this range.</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DistributionChart rows={model.categories} color="var(--chart-1)" />} />
          )}
          <BarDataTable caption="Findings by category" rows={model.categories} />
        </FigureBlock>
        <FigureBlock title="Verdict" caption="Completed reviews only. Bar length is the count.">
          {model.verdicts.every((row) => row.count === 0) ? (
            <Empty>No completed reviews in this range.</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DistributionChart rows={model.verdicts} color="var(--chart-1)" />} />
          )}
          <BarDataTable caption="Completed reviews by verdict" rows={model.verdicts} />
        </FigureBlock>
      </div>

      <FigureBlock title="Failure reasons" caption="Grouped by the error recorded for the run. Bar length is the failure count.">
        {model.failures.length === 0 ? (
          <Empty>No failed reviews in this range.</Empty>
        ) : (
          <ClientChart render={(charts) => <charts.FailureChart rows={model.failures} />} />
        )}
        <BarDataTable caption="Failed reviews by error" rows={model.failures} />
      </FigureBlock>

      <RankBlock title="Most expensive pull requests" description="Ranked by pi-ai cost, then by tokens.">
        <RankTable
          rows={model.expensive}
          columns={[
            ["Pull request", "label"],
            ["Reviews", "reviews"],
            ["Tokens", "tokens"],
            ["Cost", "cost"],
          ]}
        />
      </RankBlock>
      <RankBlock title="Repositories" description="By review count, with finding totals.">
        <RankTable
          rows={model.topRepos}
          columns={[
            ["Repository", "label"],
            ["Reviews", "reviews"],
            ["Findings", "findings"],
          ]}
        />
      </RankBlock>
      <RankBlock title="Pull requests" description="By finding count.">
        <RankTable
          rows={model.topPulls}
          columns={[
            ["Pull request", "label"],
            ["Reviews", "reviews"],
            ["Findings", "findings"],
          ]}
        />
      </RankBlock>
    </AppShell>
  );
}

function submitForm(event: { currentTarget: { form: HTMLFormElement | null } }): void {
  event.currentTarget.form?.requestSubmit();
}

function RankBlock({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex max-w-prose flex-col gap-1">
        <h2 className="text-base font-medium">{title}</h2>
        <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
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
      <caption className="sr-only">{columns.map(([label]) => label).join(", ")}</caption>
      <TableHeader>
        <TableRow>
          {columns.map(([label, key]) => (
            <TableHead key={key} scope="col" className={key === "label" ? "" : "text-right"}>
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
