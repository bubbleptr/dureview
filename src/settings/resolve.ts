import {
  DEFAULT_CHECKOUT_TTL_DAYS,
  DEFAULT_MODEL_ID,
  DEFAULT_SKIP_DRAFTS,
  DEFAULT_THINKING,
  isThinkingLevel,
  type EditableBaseline,
} from "../config.js";
import { BUILTIN_DEFAULT_TRIGGER, type ReviewTrigger } from "../review/policy.js";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const SETTING_KEYS = ["model", "thinking", "defaultTrigger", "skipDrafts", "checkoutTtlDays"] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export type SettingSource = "override" | "env" | "default";

export type ResolvedField<T> = {
  value: T;
  source: SettingSource;
  override: T | null;
  env: T | null;
  builtin: T;
  stored: boolean;
};

export type ResolvedSettings = {
  model: ResolvedField<string>;
  thinking: ResolvedField<ModelThinkingLevel>;
  defaultTrigger: ResolvedField<ReviewTrigger>;
  skipDrafts: ResolvedField<boolean>;
  checkoutTtlDays: ResolvedField<number>;
};

export function isSettingKey(value: string): value is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(value);
}

/** UI override, then environment, then the built-in default. */
export function resolveSettings(raw: ReadonlyMap<string, string>, baseline: EditableBaseline): ResolvedSettings {
  return {
    model: resolveString(raw, "model", baseline.modelId, DEFAULT_MODEL_ID, parseModelId),
    thinking: resolveString(raw, "thinking", baseline.thinking, DEFAULT_THINKING, parseThinkingSetting),
    defaultTrigger: resolveString(raw, "defaultTrigger", baseline.defaultTrigger, BUILTIN_DEFAULT_TRIGGER, parseTriggerSetting),
    skipDrafts: resolveString(raw, "skipDrafts", baseline.skipDrafts, DEFAULT_SKIP_DRAFTS, parseSkipDraftsSetting),
    checkoutTtlDays: resolveString(
      raw,
      "checkoutTtlDays",
      baseline.checkoutTtlDays,
      DEFAULT_CHECKOUT_TTL_DAYS,
      parseTtlDaysSetting,
    ),
  };
}

export function encodeSetting(key: SettingKey, value: string | ModelThinkingLevel | ReviewTrigger | boolean | number): string {
  if (key === "skipDrafts") return value === true || value === "true" ? "true" : "false";
  return String(value);
}

/**
 * Parse a stored or submitted value. `undefined` means it is not a legal value
 * for that setting (the caller decides whether that is a hard error).
 */
export function parseSettingValue(key: SettingKey, raw: string): string | ModelThinkingLevel | ReviewTrigger | boolean | number | undefined {
  if (key === "model") return parseModelId(raw);
  if (key === "thinking") return parseThinkingSetting(raw);
  if (key === "defaultTrigger") return parseTriggerSetting(raw);
  if (key === "skipDrafts") return parseSkipDraftsSetting(raw);
  return parseTtlDaysSetting(raw);
}

export function parseModelId(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

export function parseThinkingSetting(value: string): ModelThinkingLevel | undefined {
  return isThinkingLevel(value) ? value : undefined;
}

export function parseTriggerSetting(value: string): ReviewTrigger | undefined {
  if (value === "auto" || value === "once" || value === "manual") return value;
  return undefined;
}

export function parseSkipDraftsSetting(value: string): boolean | undefined {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

export function parseTtlDaysSetting(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const days = Number(trimmed);
  if (!Number.isSafeInteger(days)) return undefined;
  return days;
}

function resolveString<T>(
  raw: ReadonlyMap<string, string>,
  key: SettingKey,
  env: T | undefined,
  builtin: T,
  parse: (value: string) => T | undefined,
): ResolvedField<T> {
  const storedRaw = raw.get(key);
  const stored = storedRaw !== undefined;
  const override = storedRaw === undefined ? undefined : parse(storedRaw);
  if (override !== undefined) {
    return { value: override, source: "override", override, env: env ?? null, builtin, stored };
  }
  if (env !== undefined) {
    return { value: env, source: "env", override: null, env, builtin, stored };
  }
  return { value: builtin, source: "default", override: null, env: null, builtin, stored };
}

