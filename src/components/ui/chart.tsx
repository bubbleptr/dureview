import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/utils.js";

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
  payload?: { fill?: string };
};

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
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="grid min-w-32 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-sm">
      {label !== undefined && label !== "" ? <div className="font-medium">{label}</div> : null}
      {payload.map((item) => {
        const key = String(item.dataKey ?? item.name ?? "");
        const name = config[key]?.label ?? item.name ?? key;
        const color = item.color ?? item.payload?.fill ?? config[key]?.color;
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} />
            <span className="text-muted-foreground">{name}</span>
            <span className="ml-auto font-mono tabular-nums">{formatTooltipValue(item.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

function formatTooltipValue(value: number | string | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Intl.NumberFormat("en-US").format(value);
  if (typeof value === "string") return value;
  return "—";
}
