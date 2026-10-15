import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../ui/i18n.js";

type ChartsModule = typeof import("./stats-charts.js");

export function ClientChart({ render, className = "h-56" }: { render: (charts: ChartsModule) => ReactNode; className?: string }) {
  const { m } = useI18n();
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
  if (!charts) {
    return (
      <div className={`${className} animate-pulse rounded-md bg-muted/50 motion-reduce:animate-none`} role="status">
        <span className="sr-only">{m.overview.loadingChart}</span>
      </div>
    );
  }
  return render(charts);
}
