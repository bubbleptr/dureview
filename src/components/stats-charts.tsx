import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, XAxis, YAxis } from "recharts";
import type { StatsPageModel } from "../ui/stats-model.js";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart.js";

const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function TokenTrendChart({ trend }: { trend: StatsPageModel["trend"] }) {
  const config: ChartConfig = {};
  trend.models.forEach((model, index) => {
    config[model] = { label: model, color: PALETTE[index % PALETTE.length] };
  });
  return (
    <ChartContainer config={config} className="h-72">
      <LineChart data={trend.points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} width={48} tickFormatter={compact} />
        <ChartTooltip content={<ChartTooltipContent />} />
        {trend.models.length > 1 ? <Legend /> : null}
        {trend.models.map((model, index) => (
          <Line
            key={model}
            type="monotone"
            dataKey={model}
            name={model}
            stroke={PALETTE[index % PALETTE.length]}
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ChartContainer>
  );
}

export function DistributionChart({
  rows,
  color,
}: {
  rows: StatsPageModel["priorities"];
  color?: string;
}) {
  const config: ChartConfig = { count: { label: "Findings", color: color ?? "var(--chart-1)" } };
  return (
    <ChartContainer config={config} className="h-56">
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="name" tickLine={false} axisLine={false} interval={0} />
        <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" radius={4}>
          {rows.map((row, index) => (
            <Cell key={row.name} fill={color ?? PALETTE[index % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

export function FailureChart({ rows }: { rows: StatsPageModel["failures"] }) {
  const config: ChartConfig = { count: { label: "Failures", color: "var(--chart-1)" } };
  return (
    <ChartContainer config={config} className="h-56">
      <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="var(--border)" />
        <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={160} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" fill="var(--chart-1)" radius={4} />
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
