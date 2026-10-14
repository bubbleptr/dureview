import { join } from "node:path";
import { assertServeConfig, configFromEnv, type Config } from "../config.js";
import { createReviewModels, resolveProvider } from "../auth/session.js";
import { GithubRest } from "../github/client.js";
import { log } from "../log.js";
import { checkoutProtectionKey, cleanupCheckouts, GitCheckout } from "../review/checkout.js";
import { DureviewService } from "../service.js";
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
  return {
    service: runtime.service,
    dataDir: runtime.config.dataDir,
    provider: runtime.provider,
    modelId: runtime.config.modelId,
    githubApp: Boolean(runtime.config.githubAppId && runtime.config.githubAppPrivateKey),
    githubToken: Boolean(runtime.config.githubToken),
    startedAt: runtime.startedAt,
  };
}

async function openRuntime(): Promise<AppRuntime> {
  const config = configFromEnv();
  assertServeConfig(config);
  const models = createReviewModels(config);
  const provider = await resolveProvider(config, models);
  const model = models.getModel(provider, config.modelId);
  if (!model) {
    throw new Error(
      `Model ${provider}/${config.modelId} is not in the pi-ai catalog. Set DUREVIEW_MODEL to a model pi-ai exposes.`,
    );
  }
  const auth = await models.checkAuth(provider);
  if (!auth) {
    log("warn", "No credentials for the model provider yet. Run `dureview login` or set OPENAI_API_KEY.", {
      provider,
    });
  }
  const github = new GithubRest(config);
  const checkout = new GitCheckout(
    github,
    join(config.dataDir, "checkouts"),
    (request, signal) => github.accessToken(request, signal),
    { trigger: config.defaultTrigger },
  );
  const service = await DureviewService.open({
    config,
    models,
    github,
    checkout,
    provider,
    modelId: config.modelId,
  });
  const runtime: AppRuntime = { service, config, provider, startedAt: Date.now() };
  current = runtime;
  installShutdown();
  await sweepCheckouts(service, config);
  armCheckoutSweep(service, config);
  log("info", "dureview ready", {
    provider,
    model: config.modelId,
    github: config.githubAppId ? "app" : "pat",
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
      ttlMs: config.checkoutTtlDays * 24 * 60 * 60 * 1000,
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
