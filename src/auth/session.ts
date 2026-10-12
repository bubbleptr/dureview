import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AuthInteraction, AuthPrompt, Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { join } from "node:path";
import type { Config, ProviderName } from "../config.js";
import { log } from "../log.js";
import { FileCredentialStore } from "./store.js";

export const CODEX_PROVIDER_ID = "openai-codex";

export function authFile(config: Config): string {
  return join(config.dataDir, "auth.json");
}

export function storageFile(config: Config): string {
  return join(config.dataDir, "session.sqlite");
}

/** Models collection whose Codex OAuth refresh writes back through the data-dir store. */
export function createReviewModels(config: Config): Models {
  const models = createModels({ credentials: new FileCredentialStore(authFile(config)) });
  models.setProvider(openaiCodexProvider());
  models.setProvider(openaiProvider());
  return models;
}

/**
 * Prefer an explicit provider. Otherwise use Codex when that credential is stored,
 * the OpenAI API when `OPENAI_API_KEY` is set, and Codex as the default that `login` fills in.
 */
export async function resolveProvider(config: Config, models: Models): Promise<ProviderName> {
  if (config.provider) return config.provider;
  const codex = await models.checkAuth(CODEX_PROVIDER_ID);
  if (codex?.type === "oauth") return CODEX_PROVIDER_ID;
  if (process.env.OPENAI_API_KEY) return "openai";
  return CODEX_PROVIDER_ID;
}

export async function login(config: Config): Promise<void> {
  const models = createReviewModels(config);
  const method = process.env.DUREVIEW_LOGIN_METHOD;
  const interaction = cliInteraction(method);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Login timed out after 15 minutes.")), 15 * 60 * 1000);
  try {
    const credential = await models.login(
      CODEX_PROVIDER_ID,
      "oauth",
      { ...interaction, signal: controller.signal },
      { agentName: "dureview" },
    );
    const expires = credential.type === "oauth" ? new Date(credential.expires).toISOString() : "n/a";
    log("info", "OpenAI Codex login saved", { file: authFile(config), expires });
    console.log(`Credentials stored in ${authFile(config)}`);
    console.log("The running service refreshes this token in place. Keep the data directory on a persistent volume.");
  } finally {
    clearTimeout(timer);
    controller.abort();
    interaction.close();
  }
}

export async function logout(config: Config): Promise<void> {
  const models = createReviewModels(config);
  await models.logout(CODEX_PROVIDER_ID);
  log("info", "Removed OpenAI Codex credentials", { file: authFile(config) });
}

function cliInteraction(forcedMethod: string | undefined): AuthInteraction & { close(): void } {
  const rl = createInterface({ input, output });
  return {
    close: () => rl.close(),
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type === "select") {
          if (forcedMethod && prompt.options.some((option) => option.id === forcedMethod)) return forcedMethod;
          if (!input.isTTY) {
            const device = prompt.options.find((option) => option.id === "device_code");
            if (device) {
              console.log("No TTY; using device code login. Set DUREVIEW_LOGIN_METHOD=browser to override.");
              return device.id;
            }
          }
          console.log(prompt.message);
          prompt.options.forEach((option, index) => {
            console.log(`  ${index + 1}) ${option.label}`);
          });
          const answer = (await rl.question("> ")).trim();
          const asNumber = Number(answer);
          if (Number.isInteger(asNumber) && prompt.options[asNumber - 1]) {
            return prompt.options[asNumber - 1]!.id;
          }
          const match = prompt.options.find((option) => option.id === answer || option.label === answer);
          if (!match) throw new Error(`Unknown login choice: ${answer}`);
          return match.id;
        }
        const entered = await rl.question(`${prompt.message} `);
        return entered.trim();
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        console.log(event.instructions ?? "Open this URL and sign in with your ChatGPT subscription:");
        console.log(event.url);
        return;
      }
      if (event.type === "device_code") {
        console.log(`Open ${event.verificationUri}`);
        console.log(`Enter code: ${event.userCode}`);
        if (event.expiresInSeconds) console.log(`Expires in ${event.expiresInSeconds}s`);
        return;
      }
      if (event.type === "info" || event.type === "progress") console.log(event.message);
    },
  };
}
