import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReviewLogEntry } from "../review/history.js";
import { VERSION } from "../version.js";

const CODEX_PROVIDER = "openai-codex";

/** Codex OAuth presence. Tokens from `auth.json` are never copied onto this object. */
export type CodexLogin = {
  present: boolean;
  /** Access-token expiry as an ISO timestamp, when the stored credential has one. */
  expiresAt: string | null;
  unreadable: boolean;
};

export type DashboardStatus = {
  version: string;
  uptimeSeconds: number;
  provider: string;
  model: string;
  codex: CodexLogin;
  githubApp: boolean;
  githubToken: boolean;
  reviews: ReviewLogEntry[];
};

export async function loadDashboard(input: {
  dataDir: string | undefined;
  provider: string;
  model: string;
  githubApp: boolean;
  githubToken: boolean;
  startedAt: number;
  reviews: ReviewLogEntry[];
}): Promise<DashboardStatus> {
  const uptimeMs = Math.max(0, Date.now() - input.startedAt);
  return {
    version: VERSION,
    uptimeSeconds: Math.floor(uptimeMs / 1000),
    provider: input.provider,
    model: input.model,
    codex: await readCodexLogin(input.dataDir),
    githubApp: input.githubApp,
    githubToken: input.githubToken,
    reviews: input.reviews,
  };
}

/**
 * Read only whether the Codex OAuth login exists and when its access token expires.
 * Parse failures stay on this object as `unreadable` and do not include file text.
 */
export async function readCodexLogin(dataDir: string | undefined): Promise<CodexLogin> {
  const absent: CodexLogin = { present: false, expiresAt: null, unreadable: false };
  if (!dataDir) return absent;
  let text: string;
  try {
    text = await readFile(join(dataDir, "auth.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent;
    return { present: false, expiresAt: null, unreadable: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { present: false, expiresAt: null, unreadable: true };
  }
  if (!isRecord(parsed)) return { present: false, expiresAt: null, unreadable: true };
  const credential = parsed[CODEX_PROVIDER];
  if (credential === undefined) return absent;
  if (!isRecord(credential) || credential.type !== "oauth") {
    return { present: false, expiresAt: null, unreadable: false };
  }
  return { present: true, expiresAt: expiryIso(credential.expires), unreadable: false };
}

function expiryIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
