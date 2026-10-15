import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, XAxis, YAxis } from "recharts";
import { seriesColor } from "../ui/chart-palette.js";
import { formatTokens } from "../ui/format.js";
import { useI18n } from "../ui/i18n.js";
import type { Locale } from "../ui/locale.js";
import { seriesLabel } from "../ui/messages.js";
import type { StatsPageModel } from "../ui/stats-model.js";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart.js";

/** Recharts draws a line over 1500ms, so a load or screenshot shows a stroke that stops early. Keep the series complete on first paint, including when the user prefers reduced motion. */
export function trendLineAnimationActive(reducedMotion: boolean): boolean {
  if (reducedMotion) return false;
  return false;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function TokenTrendChart({ trend }: { trend: StatsPageModel["trend"] }) {
  const { locale } = useI18n();
  const config: ChartConfig = {};
  for (const model of trend.models) {
    config[model] = { label: model, color: seriesColor(model) };
  }
  return (
    <ChartContainer config={config} className="h-72">
      <LineChart data={trend.points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(value) => formatTokens(Number(value), locale)} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {trend.models.length > 1 ? <Legend /> : null}
        {trend.models.map((model) => (
          <Line
            key={model}
            type="monotone"
            dataKey={model}
            name={model}
            stroke={seriesColor(model)}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={trendLineAnimationActive(prefersReducedMotion())}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

export function distributionChartConfig(rows: ReadonlyArray<{ name: string }>, locale: Locale, countLabel: string): ChartConfig {
  const config: ChartConfig = {};
  for (const row of rows) config[row.name] = { label: seriesLabel(row.name, locale), color: seriesColor(row.name) };
  const count = config.count;
  config.count = { label: countLabel, color: count?.color };
  return config;
}

export function failureChartConfig(rows: ReadonlyArray<{ name: string }>, countLabel: string): ChartConfig {
  const config: ChartConfig = {};
  for (const row of rows) config[row.name] = { label: row.name, color: seriesColor(row.name) };
  const count = config.count;
  config.count = { label: countLabel, color: count?.color };
  return config;
}

export function DistributionChart({ rows }: { rows: StatsPageModel["priorities"] }) {
  const { locale, m } = useI18n();
  const config = distributionChartConfig(rows, locale, m.overview.count);
  return (
    <ChartContainer config={config} className="h-56">
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} interval={0} tickFormatter={(name) => seriesLabel(String(name), locale)} />
        <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" radius={4}>
          {rows.map((row) => (
            <Cell key={row.name} fill={seriesColor(row.name)} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

export function FailureChart({ rows }: { rows: StatsPageModel["failures"] }) {
  const { m } = useI18n();
  const config = failureChartConfig(rows, m.overview.count);
  return (
    <ChartContainer config={config} className="h-56">
      <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={160} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" radius={4}>
          {rows.map((row) => (
            <Cell key={row.name} fill={seriesColor(row.name)} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

