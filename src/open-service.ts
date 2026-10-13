import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { storageFile } from "./auth/session.js";
import { log } from "./log.js";
import { ReviewLog } from "./review/history.js";
import { createReviewRuntime } from "./review/task.js";
import { DureviewService, type ServiceOptions } from "./service.js";

/** Open the Node/Fly service: SQLite on disk, a git checkout, and the status-page log. */
export async function openDureviewService(options: ServiceOptions): Promise<DureviewService> {
  await mkdir(options.config.dataDir, { recursive: true, mode: 0o700 });
  const reviews = new ReviewLog(join(options.config.dataDir, "reviews.json"));
  const { extension, task } = createReviewRuntime({
    checkout: options.checkout,
    github: options.github,
    provider: options.provider,
    modelId: options.modelId,
    thinking: options.config.thinking,
    hooks: options.hooks,
    onFinished: (event) => reviews.finish(event),
  });
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(
    await openNodeSqliteStorage(storageFile(options.config)),
    {
      models: options.models,
      registry,
      settings: {
        extensions: [extension],
        toolExecution: "sequential",
        compaction: { enabled: false },
        retry: { maxRetries: 2 },
      },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.config.dataDir }),
      onReport: (error) => {
        log("error", "durable task error", { error: error instanceof Error ? error.message : String(error) });
      },
    },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT);
  harness.resume();
  return DureviewService.attach(harness, root.id, task, { config: options.config, github: options.github, reviews });
}
