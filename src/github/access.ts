import type { Config } from "../config.js";
import { secretTail } from "../auth/reveal.js";
import type { GitHubSetupView } from "../settings/page.js";
import type { StoredGitHubApp } from "./app-file.js";
import { githubWebOrigin } from "./web.js";

export type ActiveGitHub =
  | { kind: "app"; appId: string; privateKey: string; source: "environment" | "saved"; slug: string | null; name: string | null }
  | { kind: "token"; token: string }
  | { kind: "none" };

export type ActiveWebhook = {
  secret: string | undefined;
  source: "environment" | "saved" | "missing";
};

/**
 * Environment credentials win over the app saved from the settings page.
 * A personal access token wins over a saved app so an existing `GITHUB_TOKEN` keeps working.
 */
export function activeGitHub(
  config: Pick<Config, "githubAppId" | "githubAppPrivateKey" | "githubToken">,
  stored: StoredGitHubApp | undefined,
): ActiveGitHub {
  if (config.githubAppId && config.githubAppPrivateKey) {
    return {
      kind: "app",
      appId: config.githubAppId,
      privateKey: config.githubAppPrivateKey,
      source: "environment",
      slug: stored && stored.appId === config.githubAppId ? stored.slug : null,
      name: null,
    };
  }
  if (config.githubToken) return { kind: "token", token: config.githubToken };
  if (stored) {
    return {
      kind: "app",
      appId: stored.appId,
      privateKey: stored.privateKey,
      source: "saved",
      slug: stored.slug,
      name: stored.name,
    };
  }
  return { kind: "none" };
}

export function activeWebhookSecret(config: Pick<Config, "webhookSecret">, stored: StoredGitHubApp | undefined): ActiveWebhook {
  if (config.webhookSecret) return { secret: config.webhookSecret, source: "environment" };
  if (stored?.webhookSecret) return { secret: stored.webhookSecret, source: "saved" };
  return { secret: undefined, source: "missing" };
}

export function githubSetupView(input: {
  config: Pick<Config, "githubAppId" | "githubAppPrivateKey" | "githubToken" | "webhookSecret"> & { githubApiUrl?: string };
  stored: StoredGitHubApp | undefined;
  unreadable: boolean;
  probe: { slug: string | null; accounts: string[]; error: string | null } | null;
}): GitHubSetupView {
  const active = activeGitHub(input.config, input.stored);
  const webhook = activeWebhookSecret(input.config, input.stored);
  const slug = active.kind === "app" ? active.slug ?? input.probe?.slug ?? null : input.probe?.slug ?? null;
  const installUrl = slug ? installLink(slug, input.config.githubApiUrl ?? "https://api.github.com") : null;
  const probed = active.kind === "app" ? input.probe : null;
  const base = {
    saved: input.stored !== undefined,
    unreadable: input.unreadable,
    appId: active.kind === "app" ? active.appId : null,
    slug,
    name: active.kind === "app" ? active.name : null,
    privateKey: active.kind === "app" ? (active.source === "environment" ? "environment" : "saved") : input.stored ? "saved" : "missing",
    webhook: webhook.source,
    webhookTail: webhook.source === "saved" && input.stored ? secretTail(input.stored.webhookSecret) : null,
    installUrl,
    installations: probed && !probed.error ? probed.accounts.slice(0, 12) : null,
    installationCount: probed && !probed.error ? probed.accounts.length : null,
    installationError: probed?.error ?? null,
  } as const;
  if (active.kind === "app" && active.source === "environment") return { kind: "environment-app", ...base };
  if (active.kind === "token") return { kind: "environment-token", ...base, appId: null, privateKey: input.stored ? "saved" : "missing" };
  if (active.kind === "app") return { kind: "saved", ...base };
  return { kind: "none", ...base };
}

export function installLink(slug: string, apiUrl: string): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(slug)) return null;
  const web = githubWebOrigin(apiUrl);
  if (!web) return null;
  return `${web}/apps/${slug}/installations/new`;
}
