import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ReviewTrigger } from "../review/policy.js";
import type { SettingKey, SettingSource } from "./resolve.js";

export type SettingsFieldView = {
  key: SettingKey;
  label: string;
  envName: string;
  value: string;
  source: SettingSource;
  sourceLabel: string;
  builtin: string;
  env: string | null;
  canReset: boolean;
  help: string;
};

export type SettingsAuditView = {
  key: string;
  action: "set" | "reset";
  previous: string | null;
  value: string | null;
  actor: string;
  at: string;
};

export type SettingsFormValues = {
  model: string;
  thinking: ModelThinkingLevel;
  defaultTrigger: ReviewTrigger;
  skipDrafts: boolean;
  checkoutTtlDays: string;
};

/** Serializable settings page. Tokens, keys, and secrets are not on this object. */
export type SettingsPageModel = {
  provider: string;
  modelOptions: string[];
  thinkingByModel: Record<string, string[]>;
  fields: {
    model: SettingsFieldView;
    thinking: SettingsFieldView;
    defaultTrigger: SettingsFieldView;
    skipDrafts: SettingsFieldView;
    checkoutTtlDays: SettingsFieldView;
  };
  form: SettingsFormValues;
  problems: string[];
  audit: SettingsAuditView[];
  error: string | null;
  saved: boolean;
};

export const SOURCE_LABEL: Record<SettingSource, string> = {
  override: "Override",
  env: "Environment",
  default: "Default",
};
