import { join } from "node:path";
import { assertServeConfig, configFromEnv, editableBaseline, type Config } from "../config.js";
import { authFile, createReviewModels, resolveProvider } from "../auth/session.js";
import { FileCredentialStore } from "../auth/store.js";
import { activeGitHub, activeWebhookSecret } from "../github/access.js";
import { GitHubAppFile } from "../github/app-file.js";
import { GithubRest } from "../github/client.js";
import { log } from "../log.js";
import { checkoutProtectionKey, cleanupCheckouts, GitCheckout } from "../review/checkout.js";
import { DureviewService } from "../service.js";
import { modelChoiceError } from "../settings/validate.js";
import type { ListContext } from "../ui/list-data.js";

export type AppRuntime = {
  service: DureviewService;
  config: Config;
  provider: string;
  startedAt: number;
};

let current: AppRuntime | undefined;
let opening: Promise<AppRuntime> | undefined;
let hooks = false;
let checkoutTimer: ReturnType<typeof setInterval> | undefined;

/** Six hours. Startup runs one sweep immediately. */
const CHECKOUT_SWEEP_MS = 6 * 60 * 60 * 1000;

export function getRuntime(): Promise<AppRuntime> {
  if (current) return Promise.resolve(current);
  if (!opening) opening = openRuntime();
  return opening;
}

export async function closeRuntime(): Promise<void> {
  stopCheckoutSweep();
  const runtime = current;
  current = undefined;
  opening = undefined;
  if (runtime) await runtime.service.close();
}

export function listContext(runtime: AppRuntime): ListContext {
  const effective = runtime.service.effectiveConfig();
  return {
    service: runtime.service,
    dataDir: runtime.config.dataDir,
    provider: effective.provider,
    modelId: effective.modelId,
    thinking: effective.thinking,
    githubApp: runtime.service.githubAuthKind() === "app",
    githubToken: runtime.service.githubAuthKind() === "token",
    startedAt: runtime.startedAt,
  };
}

async function openRuntime(): Promise<AppRuntime> {
  const config = configFromEnv();
  assertServeConfig(config);
  const credentials = new FileCredentialStore(authFile(config));
  const models = createReviewModels(config, credentials);
  const githubApps = await GitHubAppFile.open(join(config.dataDir, "github-app.json"));
  const provider = await resolveProvider(config, models);
  const model = models.getModel(provider, config.modelId);
  if (!model) {
    throw new Error(
      `Model ${provider}/${config.modelId} is not in the pi-ai catalog. Set DUREVIEW_MODEL to a model pi-ai exposes.`,
    );
  }
  const auth = await models.checkAuth(provider);
  if (!auth) {
    log("warn", "No credentials for the model provider yet. Sign in on the settings page, run `dureview login`, or set an API key.", {
      provider,
    });
  }
  const githubAuth = activeGitHub(config, githubApps.current());
  if (!activeWebhookSecret(config, githubApps.current()).secret) {
    log("warn", "Webhook secret is not set. Create a GitHub App on the settings page or set DUREVIEW_WEBHOOK_SECRET.");
  }
  if (githubAuth.kind === "none") {
    log("warn", "GitHub credentials are not set. Create a GitHub App on the settings page or set GITHUB_APP_ID or GITHUB_TOKEN.");
  }
  const github = new GithubRest(config, () => githubApps.current());
  let service: DureviewService | undefined;
  const checkout = new GitCheckout(
    github,
    join(config.dataDir, "checkouts"),
    (request, signal) => github.accessToken(request, signal),
    () => ({ trigger: service?.effectiveConfig().defaultTrigger ?? config.defaultTrigger }),
  );
  service = await DureviewService.open({
    config,
    models,
    github,
    checkout,
    provider,
    modelId: config.modelId,
    baseline: editableBaseline(),
    credentials,
    githubApps,
  });
  const effective = service.effectiveConfig();
  if (modelChoiceError(models, provider, effective.modelId, effective.thinking)) {
    log("warn", "settings override is not usable; fix it on the settings page", {
      provider,
      model: effective.modelId,
      thinking: effective.thinking,
    });
  }
  const runtime: AppRuntime = { service, config, provider, startedAt: Date.now() };
  current = runtime;
  installShutdown();
  await sweepCheckouts(service, config);
  armCheckoutSweep(service, config);
  log("info", "dureview ready", {
    provider,
    model: effective.modelId,
    thinking: effective.thinking,
    github: githubAuth.kind,
    ui: config.uiToken ? "enabled" : "disabled",
    dataDir: config.dataDir,
  });
  return runtime;
}

async function sweepCheckouts(service: DureviewService, config: Config): Promise<void> {
  try {
    const running = await service.runningCheckouts();
    const removed = await cleanupCheckouts({
      root: join(config.dataDir, "checkouts"),
      ttlMs: service.checkoutTtlMs(),
      protectedKeys: new Set(running.map((item) => checkoutProtectionKey(item.owner, item.repo, item.sha))),
    });
    if (removed.length > 0) log("info", "removed old checkouts", { count: removed.length });
  } catch (error) {
    log("error", "checkout cleanup failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function armCheckoutSweep(service: DureviewService, config: Config): void {
  stopCheckoutSweep();
  checkoutTimer = setInterval(() => {
    void sweepCheckouts(service, config);
  }, CHECKOUT_SWEEP_MS);
  checkoutTimer.unref();
}

function stopCheckoutSweep(): void {
  if (!checkoutTimer) return;
  clearInterval(checkoutTimer);
  checkoutTimer = undefined;
}

function installShutdown(): void {
  if (hooks) return;
  hooks = true;
  const stop = () => {
    void closeRuntime().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
