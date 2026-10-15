import type { ReactNode } from "react";
import { TimezoneField } from "./timezone-field.js";
import { useI18n } from "../ui/i18n.js";
import type { StatsPageModel, StatsRankRow } from "../ui/stats-model.js";
import { AppShell } from "./app-shell.js";
import { ClientChart } from "./client-chart.js";
import { BarDataTable, FigureBlock, StatStrip, TrendDataTable } from "./stat-strip.js";
import { Button } from "./ui/button.js";
import { FormSelect } from "./ui/form-select.js";
import { Label } from "./ui/label.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

const RANGE_KEYS = ["24h", "7d", "30d", "all"] as const;

export function OverviewPage({ model }: { model: StatsPageModel }) {
  const { m } = useI18n();
  const copy = m.overview;
  const ranges = RANGE_KEYS.map((value) => ({ value, label: copy.ranges[value] }));
  return (
    <AppShell current="overview" title={m.shell.overview} form={{ method: "get", action: "/ui" }}>
      <div className="flex flex-col gap-2">
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">{copy.lede}</p>
        <div className="flex flex-wrap items-end gap-3 border-b pb-4">
          <Label className="flex flex-col gap-1 text-xs">
            {copy.timeRange}
            <FormSelect name="range" defaultValue={model.form.range} options={ranges} submitOnChange className="h-8 text-xs" />
          </Label>
          <Label className="flex min-w-40 flex-col gap-1 text-xs">
            {copy.repository}
            <FormSelect
              name="repo"
              defaultValue={model.form.repo}
              options={[{ value: "", label: copy.allRepos }, ...model.repos.map((repo) => ({ value: repo, label: repo }))]}
              submitOnChange
              className="h-8 w-44 text-xs"
            />
          </Label>
          <TimezoneField tz={model.form.tz} />
          <Button type="submit" size="sm">
            {copy.apply}
          </Button>
          {model.filtered ? (
            <a className="mb-1 text-sm text-muted-foreground underline-offset-4 hover:underline" href="/ui">
              {copy.clear}
            </a>
          ) : null}
        </div>
      </div>

      <StatStrip stats={model.cards} columns={6} />

      <FigureBlock title={copy.tokensTitle} caption={copy.tokensCaption}>
        {model.trend.points.length === 0 ? (
          <Empty>{copy.emptyTokens}</Empty>
        ) : (
          <ClientChart className="h-72" render={(charts) => <charts.TokenTrendChart trend={model.trend} />} />
        )}
        <TrendDataTable trend={model.trend} />
        <p className="text-xs leading-5 text-muted-foreground">{model.usageNote}</p>
      </FigureBlock>

      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <FigureBlock title={copy.priorityTitle} caption={copy.priorityCaption}>
          <ClientChart render={(charts) => <charts.DistributionChart rows={model.priorities} />} />
          <BarDataTable caption={copy.priorityTable} rows={model.priorities} />
        </FigureBlock>
        <FigureBlock title={copy.typeTitle} caption={copy.typeCaption}>
          {model.types.every((row) => row.count === 0) ? (
            <Empty>{copy.emptyFindings}</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DistributionChart rows={model.types} />} />
          )}
          <BarDataTable caption={copy.typeTable} rows={model.types} />
        </FigureBlock>
        <FigureBlock title={copy.categoryTitle} caption={copy.categoryCaption}>
          {model.categories.length === 0 ? (
            <Empty>{copy.emptyFindings}</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DistributionChart rows={model.categories} />} />
          )}
          <BarDataTable caption={copy.categoryTable} rows={model.categories} />
        </FigureBlock>
        <FigureBlock title={copy.verdictTitle} caption={copy.verdictCaption}>
          {model.verdicts.every((row) => row.count === 0) ? (
            <Empty>{copy.emptyCompleted}</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DistributionChart rows={model.verdicts} />} />
          )}
          <BarDataTable caption={copy.verdictTable} rows={model.verdicts} />
        </FigureBlock>
      </div>

      <FigureBlock title={copy.failureTitle} caption={copy.failureCaption}>
        {model.failures.length === 0 ? (
          <Empty>{copy.emptyFailures}</Empty>
        ) : (
          <ClientChart render={(charts) => <charts.FailureChart rows={model.failures} />} />
        )}
        <BarDataTable caption={copy.failureTable} rows={model.failures} translateNames={false} />
      </FigureBlock>

      <RankBlock title={copy.expensiveTitle} description={copy.expensiveDescription}>
        <RankTable
          empty={copy.emptyRank}
          rows={model.expensive}
          columns={[
            [copy.columns.pull, "label"],
            [copy.columns.reviews, "reviews"],
            [copy.columns.tokens, "tokens"],
            [copy.columns.cost, "cost"],
          ]}
        />
      </RankBlock>
      <RankBlock title={copy.reposTitle} description={copy.reposDescription}>
        <RankTable
          empty={copy.emptyRank}
          rows={model.topRepos}
          columns={[
            [copy.columns.repository, "label"],
            [copy.columns.reviews, "reviews"],
            [copy.columns.findings, "findings"],
          ]}
        />
      </RankBlock>
      <RankBlock title={copy.pullsTitle} description={copy.pullsDescription}>
        <RankTable
          empty={copy.emptyRank}
          rows={model.topPulls}
          columns={[
            [copy.columns.pull, "label"],
            [copy.columns.reviews, "reviews"],
            [copy.columns.findings, "findings"],
          ]}
        />
      </RankBlock>
    </AppShell>
  );
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
  empty,
}: {
  rows: StatsRankRow[];
  columns: Array<[string, keyof StatsRankRow]>;
  empty: string;
}) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
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
