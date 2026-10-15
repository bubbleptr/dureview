import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, XAxis, YAxis } from "recharts";
import { seriesColor } from "../ui/chart-palette.js";
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
  const config: ChartConfig = {};
  for (const model of trend.models) {
    config[model] = { label: model, color: seriesColor(model) };
  }
  return (
    <ChartContainer config={config} className="h-72">
      <LineChart data={trend.points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={compact} />
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

export function DistributionChart({ rows }: { rows: StatsPageModel["priorities"] }) {
  const config: ChartConfig = {};
  for (const row of rows) config[row.name] = { label: row.name, color: seriesColor(row.name) };
  return (
    <ChartContainer config={config} className="h-56">
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} interval={0} />
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
  const config: ChartConfig = {};
  for (const row of rows) config[row.name] = { label: row.name, color: seriesColor(row.name) };
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

function compact(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (Math.abs(value) >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}
