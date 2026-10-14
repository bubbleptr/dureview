import type { ReactNode } from "react";
import type { StatsBar, StatsPageModel } from "../ui/stats-model.js";

export function StatStrip({
  stats,
  columns = 4,
}: {
  stats: Array<{ label: string; value: string; detail: string }>;
  columns?: 4 | 6;
}) {
  return (
    <div className={columns === 6 ? "stat-strip stat-strip-6" : "stat-strip"}>
      {stats.map((stat) => (
        <div key={stat.label}>
          <p className="text-xs text-muted-foreground">{stat.label}</p>
          <p className="mt-1 text-2xl font-medium tracking-tight text-foreground tabular-nums">{stat.value}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{stat.detail}</p>
        </div>
      ))}
    </div>
  );
}

export function FigureBlock({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <figcaption className="flex max-w-prose flex-col gap-1">
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        <p className="text-sm leading-6 text-muted-foreground">{caption}</p>
      </figcaption>
      {children}
    </figure>
  );
}

export function TrendDataTable({ trend }: { trend: StatsPageModel["trend"] }) {
  if (trend.points.length === 0) return null;
  return (
    <table className="sr-only">
      <caption>Tokens by day and model</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          {trend.models.map((model) => (
            <th key={model} scope="col">
              {model}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {trend.points.map((point) => (
          <tr key={point.day}>
            <th scope="row">{point.label}</th>
            {trend.models.map((model) => (
              <td key={model}>{typeof point[model] === "number" ? point[model] : ""}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BarDataTable({ caption, rows }: { caption: string; rows: StatsBar[] }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Count</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <th scope="row">{row.name}</th>
            <td>{row.count}</td>
            <td>{row.share}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
