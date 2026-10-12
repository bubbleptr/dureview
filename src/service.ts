import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { storageFile } from "./auth/session.js";
import type { Config } from "./config.js";
import type { GitHub } from "./github/client.js";
import { verifyGithubSignature } from "./github/signature.js";
import { parseWebhook } from "./github/webhook.js";
import { log } from "./log.js";
import type { RepoCheckout } from "./review/checkout.js";
import { createReviewRuntime, enqueueReview, type EnqueueResult, type ReviewHooks, type ReviewResult } from "./review/task.js";
import type { ReviewRequest } from "./types.js";

export type ServiceOptions = {
  config: Config;
  models: Models;
  github: GitHub;
  checkout: RepoCheckout;
  provider: string;
  modelId: string;
  hooks?: ReviewHooks;
};

export type WebhookResponse = { status: number; body: Record<string, unknown> };

export class DureviewService {
  private constructor(
    readonly harness: Harness,
    private readonly rootId: ConversationId,
    private readonly task: ReturnType<typeof createReviewRuntime>["task"],
    private readonly config: Config,
  ) {}

  static async open(options: ServiceOptions): Promise<DureviewService> {
    await mkdir(options.config.dataDir, { recursive: true, mode: 0o700 });
    const { extension, task } = createReviewRuntime({
      checkout: options.checkout,
      github: options.github,
      provider: options.provider,
      modelId: options.modelId,
      thinking: options.config.thinking,
      hooks: options.hooks,
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
    return new DureviewService(harness, root.id, task, options.config);
  }

  async enqueue(request: ReviewRequest): Promise<EnqueueResult> {
    const root = await this.harness.conversation(this.rootId, BACKGROUND_CONTEXT);
    if (!root) throw new Error("Root conversation is missing.");
    const result = await enqueueReview(root, this.task, request, BACKGROUND_CONTEXT);
    log("info", result.deduped ? "skipped duplicate head" : "enqueued review", {
      repo: `${request.owner}/${request.repo}`,
      pr: request.number,
      sha: request.sha,
      taskId: String(result.taskId),
    });
    return result;
  }

  async wait(taskId: TaskId<ReviewResult>) {
    return this.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  }

  async handleWebhook(raw: Buffer, signature: string | undefined, event: string | undefined): Promise<WebhookResponse> {
    if (!this.config.webhookSecret) {
      return { status: 500, body: { error: "webhook secret is not configured" } };
    }
    if (!verifyGithubSignature(raw, signature, this.config.webhookSecret)) {
      return { status: 401, body: { error: "invalid signature" } };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      return { status: 400, body: { error: "invalid json" } };
    }
    const parsed = parseWebhook(event, payload);
    if (parsed.kind === "ping") return { status: 200, body: { ok: true } };
    if (parsed.kind === "ignore") return { status: 200, body: { ignored: true, reason: parsed.reason } };
    if (this.config.skipDrafts && parsed.request.draft) {
      return { status: 200, body: { ignored: true, reason: "draft" } };
    }
    const queued = await this.enqueue(parsed.request);
    return { status: 202, body: { taskId: queued.taskId, deduped: queued.deduped } };
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT);
  }
}
