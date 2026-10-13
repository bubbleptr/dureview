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
  dureview serve     Run the webhook service (default)

Environment:
  DUREVIEW_DATA_DIR           Credential and session storage (default: ./data)
  DUREVIEW_WEBHOOK_SECRET     GitHub webhook secret
  DUREVIEW_PROVIDER           openai-codex (default) or openai
  DUREVIEW_MODEL              Model id (default: gpt-5.5)
  OPENAI_API_KEY              Alternative to Codex OAuth when provider is openai
  GITHUB_APP_ID               GitHub App id
  GITHUB_APP_PRIVATE_KEY      GitHub App private key PEM, or a path to one
  GITHUB_TOKEN                Personal access token instead of a GitHub App
  DUREVIEW_UI_TOKEN           Status page password. Unset disables GET / and GET /ui
`);
}
