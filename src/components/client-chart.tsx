import { useEffect, useState, type ReactNode } from "react";

type ChartsModule = typeof import("./stats-charts.js");

export function ClientChart({ render }: { render: (charts: ChartsModule) => ReactNode }) {
  const [charts, setCharts] = useState<ChartsModule | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("./stats-charts.js").then((module) => {
      if (!cancelled) setCharts(module);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!charts) return <div className="h-56 animate-pulse rounded-md bg-muted/60" />;
  return render(charts);
}
