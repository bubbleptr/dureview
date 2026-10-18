import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/utils.js";
import { formatCount } from "../../ui/format.js";
import { useI18n } from "../../ui/i18n.js";
import type { Locale } from "../../ui/locale.js";

export type ChartConfig = Record<string, { label?: string; color?: string }>;

const ChartContext = React.createContext<ChartConfig | null>(null);

function useChartConfig(): ChartConfig {
  return React.useContext(ChartContext) ?? {};
}

/** shadcn chart container. ResponsiveContainer fills the parent height. */
export function ChartContainer({
  config,
  className,
  children,
}: {
  config: ChartConfig;
  className?: string;
  children: React.ReactElement;
}) {
  const style = Object.fromEntries(
    Object.entries(config).flatMap(([key, value]) => (value.color ? [[`--color-${key}`, value.color]] : [])),
  ) as React.CSSProperties;
  return (
    <ChartContext.Provider value={config}>
      <div
        className={cn(
          "flex w-full justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border",
          className,
        )}
        style={style}
      >
        <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;
export const ChartLegend = RechartsPrimitive.Legend;

type TooltipItem = {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  /** Present when the bar value is minutes and this string is the duration to show. */
  payload?: { fill?: string; duration?: unknown };
};

export function chartTooltipEntries(
  config: ChartConfig,
  label: string | number | undefined,
  payload: readonly TooltipItem[],
): { heading: string | null; rows: Array<{ key: string; name: string; value: number | string | undefined; color?: string }> } {
  const headingKey = label === undefined || label === "" ? null : String(label);
  const heading = headingKey === null ? null : (config[headingKey]?.label ?? headingKey);
  const rows = payload.map((item) => {
    const key = String(item.dataKey ?? item.name ?? "");
    const named = item.name === undefined ? undefined : config[String(item.name)]?.label;
    const name = config[key]?.label ?? named ?? item.name ?? key;
    const color = item.color ?? item.payload?.fill ?? config[key]?.color;
    return { key, name: String(name), value: tooltipValue(item), color };
  });
  return { heading, rows };
}

export function ChartTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: string | number;
}) {
  const config = useChartConfig();
  const { locale } = useI18n();
  if (!active || !payload || payload.length === 0) return null;
  const tip = chartTooltipEntries(config, label, payload);
  return (
    <div className="grid min-w-32 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-sm">
      {tip.heading ? <div className="font-medium">{tip.heading}</div> : null}
      {tip.rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: row.color }} />
          <span className="text-muted-foreground">{row.name}</span>
          <span className="ml-auto tabular-nums">{formatTooltipValue(row.value, locale)}</span>
        </div>
      ))}
    </div>
  );
}

/** Minutes are rounded to an integer by the count formatter, so 20s would show as 0. */
function tooltipValue(item: TooltipItem): number | string | undefined {
  const duration = item.payload?.duration;
  if (typeof duration === "string" && duration.length > 0) return duration;
  return item.value;
}

function formatTooltipValue(value: number | string | undefined, locale: Locale): string {
  if (typeof value === "number" && Number.isFinite(value)) return formatCount(value, locale);
  if (typeof value === "string") return value;
  return "—";
}
