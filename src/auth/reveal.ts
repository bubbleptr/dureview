import type { Credential } from "@earendil-works/pi-ai";
import type { ApiKeyView, SubscriptionView } from "../settings/page.js";
import {
  API_KEY_ENV,
  API_KEY_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  isApiKeyProvider,
  providerLabel,
  type ApiKeyProvider,
  type SubscriptionProvider,
} from "./providers.js";

const ACCOUNT_MAX = 120;

export function subscriptionView(
  provider: SubscriptionProvider,
  credential: Credential | undefined,
  unreadable: boolean,
): SubscriptionView {
  const base = {
    provider,
    label: providerLabel(provider),
    present: false,
    account: null,
    expiresAt: null,
    unreadable,
  };
  if (unreadable || credential?.type !== "oauth") return base;
  return {
    ...base,
    present: true,
    account: subscriptionAccount(credential),
    expiresAt: expiryIso(credential.expires),
  };
}

export function apiKeyView(provider: ApiKeyProvider, credential: Credential | undefined, env: NodeJS.ProcessEnv): ApiKeyView {
  const envName = API_KEY_ENV[provider];
  const fromEnv = envHas(env[envName]);
  const stored = credential?.type === "api_key" && typeof credential.key === "string" && credential.key.length > 0;
  return {
    provider,
    label: providerLabel(provider),
    envName,
    stored,
    tail: stored && credential?.type === "api_key" && credential.key ? secretTail(credential.key) : null,
    fromEnv,
  };
}

export function subscriptionViews(
  read: (provider: SubscriptionProvider) => { credential: Credential | undefined; unreadable: boolean },
): SubscriptionView[] {
  return SUBSCRIPTION_PROVIDERS.map((provider) => {
    const row = read(provider);
    return subscriptionView(provider, row.credential, row.unreadable);
  });
}

export function apiKeyViews(
  read: (provider: ApiKeyProvider) => Credential | undefined,
  env: NodeJS.ProcessEnv,
): ApiKeyView[] {
  return API_KEY_PROVIDERS.map((provider) => apiKeyView(provider, read(provider), env));
}

export function secretTail(secret: string): string | null {
  if (secret.length < 4) return null;
  return secret.slice(-4);
}

export function parseApiKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 500) return undefined;
  if (/[\s\u0000]/.test(trimmed)) return undefined;
  return trimmed;
}

export function assertApiKeyProvider(value: string): ApiKeyProvider | undefined {
  return isApiKeyProvider(value) ? value : undefined;
}

/**
 * Strip tokens and long blobs from a provider error before it reaches the page.
 * Device codes and short status text stay readable.
 */
export function publicAuthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Login failed.";
  const cleaned = raw
    .replace(/Bearer\s+\S+/gi, "Bearer …")
    .replace(/[A-Za-z0-9_\-~+/=]{20,}/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned || "Login failed.";
}

function subscriptionAccount(credential: Credential & { accountId?: unknown; enterpriseUrl?: unknown }): string | null {
  if (credential.type !== "oauth") return null;
  const email = emailFromJwt(credential.access);
  if (email && email !== credential.access && email !== credential.refresh) return email;
  if (typeof credential.accountId === "string" && isAccountLabel(credential.accountId) && credential.accountId !== credential.access) {
    return credential.accountId;
  }
  if (typeof credential.enterpriseUrl === "string" && isAccountLabel(credential.enterpriseUrl)) return credential.enterpriseUrl;
  return null;
}

function isAccountLabel(value: string): boolean {
  return value.length > 0 && value.length <= ACCOUNT_MAX && !/\s/.test(value);
}

function emailFromJwt(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload || payload.length > 20_000) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(json)) return null;
    const email = json.email;
    if (typeof email !== "string" || !isAccountLabel(email) || !email.includes("@")) return null;
    return email;
  } catch {
    return null;
  }
}

function expiryIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function envHas(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
