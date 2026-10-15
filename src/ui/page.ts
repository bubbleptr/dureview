import { githubWebOrigin } from "../github/web.js";
import type { ReviewResultKind } from "../review/archive.js";
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

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm} UTC`;
}

/** A review still marked running after this long is shown as stuck, not as a growing duration. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;

export function runningLabel(startedAt: string, now: number): "进行中" | "疑似卡住" {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "进行中";
  if (now - start >= STUCK_AFTER_MS) return "疑似卡住";
  return "进行中";
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
export function displayTrigger(trigger: string): string {
  if (trigger === "command") return "/dureview";
  if (trigger === "opened" || trigger === "synchronize" || trigger === "reopened" || trigger === "ready_for_review") {
    return "auto";
  }
  return "—";
}

export function resultLabel(kind: ReviewResultKind): string {
  if (kind === "pass") return "Pass";
  if (kind === "suggest") return "Suggestions";
  if (kind === "blocker") return "P0/P1";
  if (kind === "error") return "Error";
  return "Running";
}

export type CodexPhrase =
  | { kind: "plain"; text: string }
  | { kind: "timed"; lead: string; iso: string; label: string };

/** Same wording the status line uses for the Codex credential. `label` is the UTC timestamp. */
export function codexPhrase(codex: DashboardStatus["codex"], now = Date.now()): CodexPhrase {
  if (codex.unreadable) return { kind: "plain", text: "Codex login unreadable" };
  if (!codex.present) return { kind: "plain", text: "Codex not signed in" };
  if (!codex.expiresAt) return { kind: "plain", text: "Codex signed in" };
  const label = formatTime(codex.expiresAt);
  const expiry = Date.parse(codex.expiresAt);
  if (Number.isNaN(expiry) || label === "") return { kind: "plain", text: "Codex signed in" };
  if (expiry <= now) return { kind: "timed", lead: "Codex signed in, access token expired ", iso: codex.expiresAt, label };
  return { kind: "timed", lead: "Codex signed in, access token expires ", iso: codex.expiresAt, label };
}
