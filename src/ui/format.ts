import type { Locale } from "./locale.js";

export function intlLocale(locale: Locale): string {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z0-9]+)\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined ? "" : String(value);
  });
}

export function formatCount(value: number, locale: Locale = "en"): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(Math.max(0, Math.round(value)));
}

export function formatTokens(value: number, locale: Locale = "en"): string {
  if (locale === "zh-CN") {
    return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trimNumber(value / 1_000)}k`;
  return formatCount(value, locale);
}

export function formatCost(value: number, locale: Locale = "en"): string {
  const abs = Math.abs(value);
  const digits = abs === 0 ? 0 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  if (locale === "zh-CN") {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  }
  if (abs === 0) return "$0";
  return `$${value.toFixed(digits)}`;
}

export function formatDayLabel(day: string, locale: Locale = "en"): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match?.[1] || !match[2] || !match[3]) return day;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat(intlLocale(locale), { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}

export function formatLocalDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function trimNumber(value: number): string {
  const digits = Math.abs(value) >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}
