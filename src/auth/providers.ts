export const SUBSCRIPTION_PROVIDERS = ["openai-codex", "github-copilot", "xai"] as const;

export const API_KEY_PROVIDERS = ["openai", "openrouter", "deepseek"] as const;

export const PROVIDER_IDS = [...SUBSCRIPTION_PROVIDERS, ...API_KEY_PROVIDERS] as const;

export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

export type ProviderName = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABEL: Record<ProviderName, string> = {
  "openai-codex": "ChatGPT",
  "github-copilot": "GitHub Copilot",
  xai: "xAI",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
};

/** Environment variable pi-ai reads when no key is saved for that provider. */
export const API_KEY_ENV: Record<ApiKeyProvider, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isSubscriptionProvider(value: string): value is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}

export function isApiKeyProvider(value: string): value is ApiKeyProvider {
  return (API_KEY_PROVIDERS as readonly string[]).includes(value);
}

export function providerLabel(provider: string): string {
  return isProviderName(provider) ? PROVIDER_LABEL[provider] : provider;
}

/** Provider id when `text` is that id or starts with `id/`. Longer ids win, so `openai-codex` beats `openai`. */
export function providerAtStart(text: string): ProviderName | null {
  const ids = [...PROVIDER_IDS].toSorted((left, right) => right.length - left.length);
  for (const id of ids) {
    if (text === id || text.startsWith(`${id}/`)) return id;
  }
  return null;
}
