#!/usr/bin/env node
import { login, logout } from "./auth/session.js";
import { configFromEnv } from "./config.js";
import { serveCommand } from "./server.js";

const command = process.argv[2] ?? "serve";

try {
  if (command === "login") {
    await login(configFromEnv());
  } else if (command === "logout") {
    await logout(configFromEnv());
  } else if (command === "serve") {
    await serveCommand(configFromEnv());
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`dureview — adversarial pull request review

Usage:
  dureview login     Sign in with a ChatGPT subscription (Codex OAuth)
  dureview logout    Remove the stored Codex credential
  dureview serve     Run the built TanStack Start server (default)
  npm run dev        Local development server with live reload

  /ui/settings also signs in with a device code for ChatGPT, GitHub Copilot, and xAI,
  stores OpenAI, OpenRouter, and DeepSeek API keys, and creates a GitHub App.

Environment:
  DUREVIEW_DATA_DIR           Credential and session storage (default: ./data)
  DUREVIEW_WEBHOOK_SECRET     GitHub webhook secret. A saved GitHub App supplies one when this is unset
  DUREVIEW_PROVIDER           openai-codex, github-copilot, xai, openai, openrouter, or deepseek
  DUREVIEW_MODEL              Model id (default: gpt-5.5)
  DUREVIEW_DEFAULT_TRIGGER    auto, once, or manual (default: manual)
  OPENAI_API_KEY              OpenAI API key. A key saved on the settings page overrides it
  OPENROUTER_API_KEY          OpenRouter API key. A saved key overrides it
  DEEPSEEK_API_KEY            DeepSeek API key. A saved key overrides it
  GITHUB_APP_ID               GitHub App id. With the private key, this wins over a saved app
  GITHUB_APP_PRIVATE_KEY      GitHub App private key PEM, or a path to one
  GITHUB_TOKEN                Personal access token. Wins over a saved GitHub App
  DUREVIEW_UI_TOKEN           Status page password. Unset disables GET /, GET /ui, GET /ui/reviews, and GET /ui/settings
                              Provider, model, thinking, trigger, draft skip, checkout TTL, logins, API keys,
                              and the GitHub App can be changed at /ui/settings
`);
}
