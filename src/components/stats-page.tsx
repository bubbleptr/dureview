import type { ReactNode } from "react";
import { TimezoneField } from "./timezone-field.js";
import { fill, formatCount, formatPercent } from "../ui/format.js";
import { useI18n } from "../ui/i18n.js";
import type { Locale } from "../ui/locale.js";
import { seriesLabel } from "../ui/messages.js";
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
  const { m, locale } = useI18n();
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

      {model.failures.length > 0 ? <FailureBanner rows={model.failures} /> : null}

      <section className="flex min-w-0 flex-col gap-6">
        <div className="flex max-w-prose flex-col gap-1">
          <h2 className="text-base font-medium">{copy.adoptionTitle}</h2>
          <p className="text-sm leading-6 text-muted-foreground">{copy.adoptionCaption}</p>
        </div>
        <StatStrip stats={model.adoptionCards} />
        <FigureBlock title={copy.adoptionTrendTitle} caption={copy.adoptionTrendCaption}>
          {model.adoptionTrend.length === 0 ? (
            <Empty>{copy.emptyAdoption}</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.AdoptionTrendChart points={model.adoptionTrend} />} />
          )}
          <AdoptionTable points={model.adoptionTrend} />
        </FigureBlock>
      </section>

      <section className="flex min-w-0 flex-col gap-6">
        <h2 className="text-base font-medium">{copy.recurringTitle}</h2>
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex max-w-prose flex-col gap-1">
              <h3 className="text-sm font-medium">{copy.categoryCluster}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{copy.recurringCaption}</p>
            </div>
            {model.recurring.length === 0 ? (
              <Empty>{copy.emptyRecurring}</Empty>
            ) : (
              <RecurringTable groups={model.recurring} locale={locale} />
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex max-w-prose flex-col gap-1">
              <h3 className="text-sm font-medium">{copy.hotspotsTitle}</h3>
              <p className="text-sm leading-6 text-muted-foreground">{copy.hotspotsCaption}</p>
            </div>
            {model.hotspots.length === 0 ? (
              <Empty>{copy.emptyRecurring}</Empty>
            ) : (
              <HotspotTable rows={model.hotspots} />
            )}
          </div>
        </div>
      </section>

      <section className="flex min-w-0 flex-col gap-6">
        <div className="flex max-w-prose flex-col gap-1">
          <h2 className="text-base font-medium">{copy.speedTitle}</h2>
          <p className="text-sm leading-6 text-muted-foreground">{copy.speedCaption}</p>
        </div>
        {model.outlier ? (
          <p className="max-w-prose text-sm leading-6">
            <span className="font-medium">{model.outlier.headline}</span>{" "}
            <span className="text-muted-foreground">{model.outlier.detail}</span>
          </p>
        ) : null}
        <StatStrip stats={model.speedCards} />
        <FigureBlock title={copy.durationTitle} caption={copy.durationCaption}>
          {model.speed.length === 0 ? (
            <Empty>{copy.emptySpeed}</Empty>
          ) : (
            <ClientChart render={(charts) => <charts.DurationChart points={model.speed} medianMinutes={model.medianMinutes} />} />
          )}
          <DurationTable points={model.speed} />
        </FigureBlock>
        <FigureBlock title={copy.tokensTitle} caption={copy.tokensCaption}>
          {model.trend.points.length === 0 ? (
            <Empty>{copy.emptyTokens}</Empty>
          ) : (
            <ClientChart className="h-72" render={(charts) => <charts.TokenTrendChart trend={model.trend} />} />
          )}
          <TrendDataTable trend={model.trend} />
          <p className="text-xs leading-5 text-muted-foreground">{model.usageNote}</p>
        </FigureBlock>
      </section>

      <details className="border-t">
        <summary className="cursor-pointer py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {copy.detailsTitle}
        </summary>
        <div className="flex flex-col gap-10 pb-2">
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">{copy.detailsCaption}</p>
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
        </div>
      </details>
    </AppShell>
  );
}

function FailureBanner({ rows }: { rows: StatsPageModel["failures"] }) {
  const { m, locale } = useI18n();
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const headline = total === 1 ? m.overview.failureAlertOne : fill(m.overview.failureAlert, { count: formatCount(total, locale) });
  return (
    <div role="alert" className="border border-border px-4 py-3">
      <p className="text-sm font-medium">{headline}</p>
      <ul className="mt-2 flex flex-col gap-1">
        {rows.slice(0, 4).map((row) => (
          <li key={row.name} className="text-sm text-muted-foreground">
            <span className="text-foreground">{row.name}</span>
            <span className="tabular-nums"> · {formatCount(row.count, locale)}</span>
          </li>
        ))}
      </ul>
      <BarDataTable caption={m.overview.failureTable} rows={rows} translateNames={false} />
    </div>
  );
}

function AdoptionTable({ points }: { points: StatsPageModel["adoptionTrend"] }) {
  const { m, locale } = useI18n();
  if (points.length === 0) return null;
  return (
    <table className="sr-only">
      <caption>{m.overview.adoptionTrendTable}</caption>
      <thead>
        <tr>
          <th scope="col">{m.overview.day}</th>
          <th scope="col">{m.overview.adopted}</th>
          <th scope="col">{m.overview.ignored}</th>
          <th scope="col">{m.overview.rate}</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point) => (
          <tr key={point.day}>
            <th scope="row">{point.label}</th>
            <td>{formatCount(point.adopted, locale)}</td>
            <td>{formatCount(point.ignored, locale)}</td>
            <td>{formatPercent(point.rate / 100, locale)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DurationTable({ points }: { points: StatsPageModel["speed"] }) {
  const { m } = useI18n();
  if (points.length === 0) return null;
  return (
    <table className="sr-only">
      <caption>{m.overview.durationTable}</caption>
      <thead>
        <tr>
          <th scope="col">{m.overview.columns.pull}</th>
          <th scope="col">{m.overview.columns.duration}</th>
        </tr>
      </thead>
      <tbody>
        {points.map((point) => (
          <tr key={point.id}>
            <th scope="row">{point.detail}</th>
            <td>{point.duration}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RecurringTable({ groups, locale }: { groups: StatsPageModel["recurring"]; locale: Locale }) {
  const { m } = useI18n();
  return (
    <Table>
      <caption className="sr-only">{m.overview.recurringTitle}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{m.overview.columns.category}</TableHead>
          <TableHead scope="col" className="text-right">
            {m.overview.columns.findings}
          </TableHead>
        </TableRow>
      </TableHeader>
      {groups.map((group) => (
        <TableBody key={group.category}>
          <TableRow>
            <TableCell className="font-medium">{categoryName(group.category, locale)}</TableCell>
            <TableCell className="text-right tabular-nums">{group.count}</TableCell>
          </TableRow>
          {group.titles.map((title) => (
            <TableRow key={`${group.category}:${title.title}`}>
              <TableCell className="pl-6 text-muted-foreground">{title.title}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{title.count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      ))}
    </Table>
  );
}

function HotspotTable({ rows }: { rows: StatsPageModel["hotspots"] }) {
  const { m } = useI18n();
  return (
    <Table>
      <caption className="sr-only">{m.overview.hotspotsTitle}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{m.overview.columns.repository}</TableHead>
          <TableHead scope="col">{m.overview.columns.directory}</TableHead>
          <TableHead scope="col" className="text-right">
            {m.overview.columns.findings}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.repo}:${row.directory}`}>
            <TableCell className="font-mono text-xs">{row.repo}</TableCell>
            <TableCell className="font-mono text-xs">{row.directory === "." ? m.overview.rootDirectory : row.directory}</TableCell>
            <TableCell className="text-right tabular-nums">{row.count}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function categoryName(category: string, locale: Locale): string {
  return seriesLabel(category.replaceAll("_", " "), locale);
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
