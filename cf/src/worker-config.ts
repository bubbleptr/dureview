import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Config } from "../../src/config.js";
import { BUILTIN_DEFAULT_TRIGGER, type ReviewTrigger } from "../../src/review/policy.js";

const THINKING = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Worker bindings as the same config shape the Node service uses. Does not read the filesystem. */
export function workerConfig(env: Env): Config {
  return {
    dataDir: "data",
    host: "0.0.0.0",
    port: 0,
    webhookSecret: blank(env.DUREVIEW_WEBHOOK_SECRET),
    provider: undefined,
    modelId: blank(env.MODEL_ID) ?? "deepseek-chat",
    thinking: thinkingOf(env.DUREVIEW_THINKING),
    githubToken: blank(env.GITHUB_TOKEN),
    githubAppId: blank(env.GITHUB_APP_ID),
    githubAppPrivateKey: pem(env.GITHUB_APP_PRIVATE_KEY),
    githubApiUrl: (blank(env.GITHUB_API_URL) ?? "https://api.github.com").replace(/\/$/, ""),
    skipDrafts: env.DUREVIEW_SKIP_DRAFTS === "1" || env.DUREVIEW_SKIP_DRAFTS === "true",
    uiToken: undefined,
    defaultTrigger: triggerOf(env.DUREVIEW_DEFAULT_TRIGGER),
  };
}

export function blank(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return value;
}

function pem(value: string | undefined): string | undefined {
  const text = blank(value);
  if (!text) return undefined;
  return text.replace(/\\n/g, "\n");
}

function thinkingOf(value: string | undefined): ModelThinkingLevel {
  const level = blank(value) ?? "off";
  if (THINKING.has(level as ModelThinkingLevel)) return level as ModelThinkingLevel;
  throw new Error(`DUREVIEW_THINKING must be one of ${[...THINKING].join(", ")}.`);
}

function triggerOf(value: string | undefined): ReviewTrigger {
  const trigger = blank(value);
  if (trigger === undefined) return BUILTIN_DEFAULT_TRIGGER;
  if (trigger === "auto" || trigger === "once" || trigger === "manual") return trigger;
  throw new Error(`DUREVIEW_DEFAULT_TRIGGER must be auto, once, or manual, got ${trigger}.`);
}
