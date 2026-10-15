import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ApiKeyProvider, SubscriptionProvider } from "../auth/providers.js";
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
  /** Empty keeps the current provider. */
  provider?: string;
  model: string;
  thinking: ModelThinkingLevel;
  defaultTrigger: ReviewTrigger;
  skipDrafts: boolean;
  checkoutTtlDays: string;
};

export type CatalogModel = {
  id: string;
  thinking: string[];
};

export type ProviderCatalog = {
  provider: string;
  label: string;
  models: CatalogModel[];
};

export type SubscriptionView = {
  provider: SubscriptionProvider;
  label: string;
  present: boolean;
  account: string | null;
  expiresAt: string | null;
  unreadable: boolean;
};

export type ApiKeyView = {
  provider: ApiKeyProvider;
  label: string;
  envName: string;
  stored: boolean;
  tail: string | null;
  fromEnv: boolean;
};

export type LoginView = {
  provider: SubscriptionProvider;
  phase: "starting" | "code" | "done" | "error";
  verificationUri: string | null;
  userCode: string | null;
  expiresAt: string | null;
  message: string | null;
};

export type GitHubSetupView = {
  kind: "environment-app" | "environment-token" | "saved" | "none";
  saved: boolean;
  unreadable: boolean;
  appId: string | null;
  slug: string | null;
  name: string | null;
  privateKey: "environment" | "saved" | "missing";
  webhook: "environment" | "saved" | "missing";
  webhookTail: string | null;
  installUrl: string | null;
  installations: string[] | null;
  installationCount: number | null;
  installationError: string | null;
};

export type ConsoleView = {
  subscriptions: SubscriptionView[];
  apiKeys: ApiKeyView[];
  logins: LoginView[];
  github: GitHubSetupView;
};

/** Serializable settings page. Tokens, keys, and secrets are not on this object. */
export type SettingsPageModel = {
  provider: string;
  modelOptions: string[];
  thinkingByModel: Record<string, string[]>;
  catalogs: ProviderCatalog[];
  fields: {
    provider: SettingsFieldView;
    model: SettingsFieldView;
    thinking: SettingsFieldView;
    defaultTrigger: SettingsFieldView;
    skipDrafts: SettingsFieldView;
    checkoutTtlDays: SettingsFieldView;
  };
  form: SettingsFormValues;
  console: ConsoleView;
  problems: string[];
  audit: SettingsAuditView[];
  error: string | null;
  notice: string | null;
  saved: boolean;
};

export function emptyConsole(): ConsoleView {
  return {
    subscriptions: [],
    apiKeys: [],
    logins: [],
    github: {
      kind: "none",
      saved: false,
      unreadable: false,
      appId: null,
      slug: null,
      name: null,
      privateKey: "missing",
      webhook: "missing",
      webhookTail: null,
      installUrl: null,
      installations: null,
      installationCount: null,
      installationError: null,
    },
  };
}

export const SOURCE_LABEL: Record<SettingSource, string> = {
  override: "Override",
  env: "Environment",
  default: "Default",
};
