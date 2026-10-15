import { Bug, Flag, Shield, TriangleAlert } from "lucide-react";
import type { ComponentType } from "react";
import { confidenceBars, formatConfidence } from "../review/confidence.js";
import { fill } from "../ui/format.js";
import { findingIconKind, type FindingIconKind } from "../ui/finding-icon.js";
import { useI18n } from "../ui/i18n.js";

const PRIORITY_TONE = [
  "bg-[color-mix(in_oklch,var(--chart-1)_18%,transparent)] text-chart-1",
  "bg-[color-mix(in_oklch,var(--chart-2)_18%,transparent)] text-chart-2",
  "bg-[color-mix(in_oklch,var(--chart-3)_18%,transparent)] text-chart-3",
  "bg-[color-mix(in_oklch,var(--chart-4)_18%,transparent)] text-chart-4",
] as const;

const ICON: Record<FindingIconKind, { Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>; className: string }> = {
  "bug-severe": { Icon: Bug, className: "text-red-600 dark:text-red-400" },
  "bug-other": { Icon: TriangleAlert, className: "text-amber-600 dark:text-amber-400" },
  "flag-investigate": { Icon: Flag, className: "text-orange-600 dark:text-orange-400" },
  "flag-info": { Icon: Flag, className: "text-muted-foreground" },
  security: { Icon: Shield, className: "text-chart-3" },
};

export function PriorityBadge({ priority }: { priority: number }) {
  const index = priority === 0 || priority === 1 || priority === 2 || priority === 3 ? priority : 3;
  return (
    <span className={`inline-flex h-5 items-center rounded px-1.5 text-[11px] font-medium leading-none tabular-nums ${PRIORITY_TONE[index]}`}>
      P{index}
    </span>
  );
}

export function FindingTypeIcon({
  type,
  subtype,
  label,
}: {
  type: string | null;
  subtype: string | null;
  label: string | null;
}) {
  const kind = findingIconKind(type, subtype);
  if (!kind || !label) return null;
  const { Icon, className } = ICON[kind];
  return (
    <span className="inline-flex" role="img" aria-label={label} title={label}>
      <Icon aria-hidden className={`size-3.5 ${className}`} />
    </span>
  );
}

export function ConfidenceSignal({ value }: { value: number }) {
  const { m } = useI18n();
  const exact = formatConfidence(value);
  const label = fill(m.detail.confidenceExact, { value: exact });
  const bars = confidenceBars(value);
  return (
    <span className="inline-flex items-end gap-0.5" role="img" aria-label={label} title={exact}>
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          aria-hidden
          className={`w-[3px] rounded-[1px] ${bar <= bars ? "bg-foreground" : "bg-muted-foreground/30"}`}
          style={{ height: 4 + bar * 3 }}
        />
      ))}
    </span>
  );
}
