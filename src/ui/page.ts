import { githubWebOrigin } from "../github/web.js";
import type { ReviewResultKind } from "../review/archive.js";
import type { Locale } from "./locale.js";
import { messages } from "./messages.js";
import type { DashboardStatus } from "./status.js";

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Public pull request URL, or null when the coordinates are not safe to put in an href. */
export function pullRequestUrl(apiUrl: string, owner: string, repo: string, number: number): string | null {
  if (!NAME.test(owner) || owner.length > 100 || !NAME.test(repo) || repo.length > 100) return null;
  if (!Number.isInteger(number) || number < 1) return null;
  const web = githubWebOrigin(apiUrl);
  if (!web) return null;
  return `${web}/${owner}/${repo}/pull/${number}`;
}

export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function formatTime(iso: string, locale: Locale = "en"): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (locale === "zh-CN") {
    const formatted = new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "UTC",
    }).format(date);
    return `${formatted} UTC`;
  }
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

/** A review still marked running after this long is shown as stuck, not as a growing duration. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;

export function runningLabel(startedAt: string, now: number, locale: Locale = "en"): string {
  const copy = messages[locale].status;
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return copy.inProgress;
  if (now - start >= STUCK_AFTER_MS) return copy.stuck;
  return copy.inProgress;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return secs === 0 ? `${minutes}m` : `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

export function reviewDurationMs(startedAt: string, finishedAt: string | null, now = Date.now()): number | null {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  const end = finishedAt ? Date.parse(finishedAt) : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** Automatic pull request events are `auto`. A comment command is `/dureview`. */
export function displayTrigger(trigger: string, locale: Locale = "en"): string {
  if (trigger === "command") return "/dureview";
  if (trigger === "opened" || trigger === "synchronize" || trigger === "reopened" || trigger === "ready_for_review") {
    return messages[locale].status.auto;
  }
  return "—";
}

export function resultLabel(kind: ReviewResultKind, locale: Locale = "en"): string {
  const copy = messages[locale].status;
  if (kind === "pass") return copy.pass;
  if (kind === "suggest") return copy.suggest;
  if (kind === "blocker") return copy.blocker;
  if (kind === "error") return copy.error;
  return copy.running;
}

export type CodexPhrase =
  | { kind: "plain"; text: string }
  | { kind: "timed"; lead: string; iso: string; label: string };

/** Same wording the status line uses for the Codex credential. `label` is the UTC timestamp. */
export function codexPhrase(codex: DashboardStatus["codex"], now = Date.now(), locale: Locale = "en"): CodexPhrase {
  const copy = messages[locale].status;
  if (codex.unreadable) return { kind: "plain", text: copy.codexUnreadable };
  if (!codex.present) return { kind: "plain", text: copy.codexSignedOut };
  if (!codex.expiresAt) return { kind: "plain", text: copy.codexSignedIn };
  const label = formatTime(codex.expiresAt, locale);
  const expiry = Date.parse(codex.expiresAt);
  if (Number.isNaN(expiry) || label === "") return { kind: "plain", text: copy.codexSignedIn };
  if (expiry <= now) return { kind: "timed", lead: copy.codexExpired, iso: codex.expiresAt, label };
  return { kind: "timed", lead: copy.codexExpires, iso: codex.expiresAt, label };
}
