import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { scriptedReview } from "./script.js";
import { workerConfig } from "./worker-config.js";

export type WorkerModels = {
  models: Models;
  provider: string;
  modelId: string;
};

/**
 * OpenAI-compatible chat model. DeepSeek is the example: base URL and model id come from bindings.
 * `MODEL_PROVIDER=faux` is the local stand-in and does not call the network.
 */
export function createWorkerModels(env: Env): WorkerModels {
  const config = workerConfig(env);
  const providerId = blankProvider(env.MODEL_PROVIDER);
  if (providerId === "faux") {
    const faux = fauxProvider();
    faux.setResponses(scriptedReview());
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, provider: "faux", modelId: config.modelId === "deepseek-chat" ? "faux-1" : config.modelId };
  }
  const baseUrl = (env.MODEL_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  const modelId = config.modelId;
  const provider = createProvider({
    id: providerId,
    name: "OpenAI-compatible",
    baseUrl,
    auth: { apiKey: modelApiKeyAuth() },
    models: [
      {
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: providerId,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
    api: openAICompletionsApi(),
  });
  const models = createModels({
    authContext: {
      env: async (name) => (name === "MODEL_API_KEY" ? env.MODEL_API_KEY : undefined),
      fileExists: async () => false,
    },
  });
  models.setProvider(provider);
  return { models, provider: providerId, modelId };
}

/** pi-ai's helper is not a public export. Resolve the Worker secret the same way. */
function modelApiKeyAuth() {
  return {
    name: "Model API key",
    login: async () => {
      throw new Error("Set the MODEL_API_KEY secret. This Worker does not prompt for a key.");
    },
    resolve: async ({ ctx, credential, signal }: {
      ctx: { env(name: string): Promise<string | undefined> };
      credential?: { key?: string };
      signal: AbortSignal;
    }) => {
      signal.throwIfAborted();
      if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
      const value = await ctx.env("MODEL_API_KEY");
      signal.throwIfAborted();
      if (value) return { auth: { apiKey: value }, source: "MODEL_API_KEY" };
      return undefined;
    },
  };
}

function blankProvider(value: string | undefined): string {
  const text = value?.trim();
  return text && text.length > 0 ? text : "deepseek";
}
