import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { BUILTIN_DEFAULT_TRIGGER, type ReviewTrigger } from "./review/policy.js";

/**
 * Default chat model in pi-ai's `openai-codex` catalog.
 * `gpt-5.4` is not in that catalog (it was removed from ChatGPT-account Codex).
 * `gpt-5.5` is also in the OpenAI API catalog, so the same id works for `OPENAI_API_KEY`.
 */
export const DEFAULT_MODEL_ID = "gpt-5.5";

export const DEFAULT_PROVIDER = "openai-codex" as const;

export type ProviderName = "openai-codex" | "openai";

const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export type Config = {
  dataDir: string;
  host: string;
  port: number;
  webhookSecret: string | undefined;
  /** Unset until login/credentials are inspected. `serve` resolves a concrete provider. */
  provider: ProviderName | undefined;
  modelId: string;
  thinking: ModelThinkingLevel;
  githubToken: string | undefined;
  githubAppId: string | undefined;
  githubAppPrivateKey: string | undefined;
  githubApiUrl: string;
  skipDrafts: boolean;
  /** When unset, `GET /` and `GET /ui` stay disabled. */
  uiToken: string | undefined;
  /**
   * Trigger used when the base branch has no `.dureview.md`, or the file does not set `trigger`.
   * `auto` and `once` opt the whole server in. `manual` waits for `/dureview`.
   */
  defaultTrigger: ReviewTrigger;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = parseProvider(env.DUREVIEW_PROVIDER);
  const thinking = parseThinking(env.DUREVIEW_THINKING ?? "medium");
  const port = parsePort(env.DUREVIEW_PORT ?? "8787");
  return {
    dataDir: resolve(env.DUREVIEW_DATA_DIR ?? "data"),
    host: env.DUREVIEW_HOST ?? "0.0.0.0",
    port,
    webhookSecret: emptyToUndefined(env.DUREVIEW_WEBHOOK_SECRET ?? env.GITHUB_WEBHOOK_SECRET),
    provider,
    modelId: emptyToUndefined(env.DUREVIEW_MODEL) ?? DEFAULT_MODEL_ID,
    thinking,
    githubToken: emptyToUndefined(env.GITHUB_TOKEN),
    githubAppId: emptyToUndefined(env.GITHUB_APP_ID),
    githubAppPrivateKey: loadPrivateKey(env),
    githubApiUrl: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, ""),
    skipDrafts: env.DUREVIEW_SKIP_DRAFTS === "1" || env.DUREVIEW_SKIP_DRAFTS === "true",
    uiToken: emptyToUndefined(env.DUREVIEW_UI_TOKEN)?.trim(),
    defaultTrigger: parseDefaultTrigger(env.DUREVIEW_DEFAULT_TRIGGER),
  };
}

export function assertServeConfig(config: Config): void {
  if (!config.webhookSecret) {
    throw new Error("DUREVIEW_WEBHOOK_SECRET is required to verify GitHub webhook signatures.");
  }
  const app = Boolean(config.githubAppId && config.githubAppPrivateKey);
  if (!app && !config.githubToken) {
    throw new Error("Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN.");
  }
  if (config.githubAppId && !config.githubAppPrivateKey) {
    throw new Error("GITHUB_APP_ID is set but no GitHub App private key was found.");
  }
}

function parseDefaultTrigger(value: string | undefined): ReviewTrigger {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return BUILTIN_DEFAULT_TRIGGER;
  if (trimmed === "auto" || trimmed === "once" || trimmed === "manual") return trimmed;
  throw new Error(`DUREVIEW_DEFAULT_TRIGGER must be auto, once, or manual, got ${value}.`);
}

function parseProvider(value: string | undefined): ProviderName | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "openai-codex" || value === "openai") return value;
  throw new Error(`DUREVIEW_PROVIDER must be "openai-codex" or "openai", got ${value}.`);
}

function parseThinking(value: string): ModelThinkingLevel {
  if (THINKING_LEVELS.has(value as ModelThinkingLevel)) return value as ModelThinkingLevel;
  throw new Error(`DUREVIEW_THINKING must be one of ${[...THINKING_LEVELS].join(", ")}.`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DUREVIEW_PORT must be a TCP port, got ${value}.`);
  }
  return port;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function loadPrivateKey(env: NodeJS.ProcessEnv): string | undefined {
  const inline = env.GITHUB_APP_PRIVATE_KEY;
  const pathValue = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (pathValue) return readPem(pathValue);
  if (!inline) return undefined;
  if (inline.includes("BEGIN")) return inline.replace(/\\n/g, "\n");
  if (inline.endsWith(".pem") || inline.includes("/") || inline.includes("\\")) return readPem(inline);
  return inline.replace(/\\n/g, "\n");
}

function readPem(file: string): string {
  const path = isAbsolute(file) ? file : resolve(file);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read GitHub App private key at ${path}: ${message}`);
  }
}
