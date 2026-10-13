import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { Lifecycle } from "agents/lifecycle";
import type { PiHarnessContext } from "agents/harness/pi";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { generateKeyPairSync } from "node:crypto";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type Harness as PiHarness } from "@earendil-works/pi-durable";
import { GithubRest, appJwt, type GitHub } from "../../src/github/client.js";
import { log } from "../../src/log.js";
import { createReviewRuntime } from "../../src/review/task.js";
import { DureviewService, type ReviewRecorder } from "../../src/service.js";
import type { ReviewRequest } from "../../src/types.js";
import { WorkspaceCheckout, type CloneStats } from "./checkout.js";
import { ReviewPiHarness } from "./harness.js";
import { MemoryGitHub } from "./memory-github.js";
import { createWorkerModels } from "./model.js";
import { workerConfig } from "./worker-config.js";
import { WorkspaceRepoFs } from "./workspace-fs.js";

export type Inspection = {
  postEntered: boolean;
  pausesRemaining: number;
  gitBase: string | null;
  clone: CloneStats | null;
  file: string | null;
  bytes: number;
  memory: { comments: string[]; reviews: number } | null;
  task: { status: string; error?: string } | null;
  toolText: string;
};

const memoryReviews: ReviewRecorder = {
  async start() {},
  async finish() {},
  async list() {
    return [];
  },
};

export class ReviewSession extends DurableObject<Env> {
  readonly workspace: Workspace;
  readonly harness: ReviewPiHarness;
  readonly lifecycle: Lifecycle<Env>;
  #github: GitHub;
  #pi: PiHarness | undefined;
  #service: DureviewService | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#github = createGithub(env);
    this.workspace = new Workspace({ storage: ctx.storage, git: createGitClient() });
    this.harness = new ReviewPiHarness({ harness: (input) => this.#openPi(input) });
    this.lifecycle = Lifecycle.install(this).use(this.harness);
  }

  async dispatch(event: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    await this.lifecycle.start();
    const service = this.#service;
    if (!service) throw new Error("Review service did not open.");
    const result = await service.dispatch(event.length > 0 ? event : undefined, payload);
    const taskId = result.body.taskId;
    if (typeof taskId === "number") await this.ctx.storage.put("dureview:lastTaskId", taskId);
    if (result.status === 202) await this.harness.wakeSession(String(ROOT_CONVERSATION_ID));
    return result;
  }

  async armPause(): Promise<void> {
    this.#assertTest();
    await this.ctx.storage.put("dureview:pause", true);
    await this.ctx.storage.delete("dureview:postEntered");
  }

  /** Allow the post phase on the next invocation. Does not start the harness. */
  async releasePause(): Promise<void> {
    this.#assertTest();
    await this.ctx.storage.put("dureview:pause", false);
  }

  /**
   * Abort the in-flight post without faulting it, and leave a future alarm so
   * this isolate does not resume before eviction. The replacement isolate's
   * alarm runs the post.
   */
  async crashHarness(): Promise<void> {
    this.#assertTest();
    await this.lifecycle.start();
    await this.harness.dispose();
    await this.lifecycle.disableAlarms();
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async probeCrypto(): Promise<{ ok: boolean; error?: string }> {
    this.#assertTest();
    try {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
      });
      const jwt = appJwt("12345", privateKey);
      const parts = jwt.split(".");
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) return { ok: false, error: "jwt shape" };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async inspection(): Promise<Inspection> {
    this.#assertTest();
    const postEntered = (await this.ctx.storage.get<boolean>("dureview:postEntered")) === true;
    const pausesRemaining = (await this.ctx.storage.get<boolean>("dureview:pause")) === true ? 1 : 0;
    const gitBase = (await this.ctx.storage.get<string>("dureview:gitBase")) ?? null;
    const clone = (await this.ctx.storage.get<CloneStats>("dureview:clone")) ?? null;
    let file: string | null = null;
    try {
      file = await this.workspace.fs.readFile("/repo/src/pay.ts", "utf8");
    } catch {
      file = null;
    }
    const memory = this.#github instanceof MemoryGitHub
      ? { comments: this.#github.comments.map((comment) => comment.body), reviews: this.#github.reviews.length }
      : null;
    const busy = postEntered && (memory?.comments.length ?? 0) === 0;
    let task: Inspection["task"] = null;
    let toolText = "";
    if (!busy && this.#pi) {
      const taskId = await this.ctx.storage.get<number>("dureview:lastTaskId");
      if (typeof taskId === "number") {
        const read = await this.#readTask(taskId);
        task = read.task;
        toolText = read.toolText;
      }
    }
    return {
      postEntered,
      pausesRemaining,
      gitBase,
      clone,
      file,
      bytes: sqliteBytes(this.ctx.storage),
      memory,
      task,
      toolText,
    };
  }

  async #openPi({ storage, context }: PiHarnessContext): Promise<PiHarness> {
    const config = workerConfig(this.env);
    const { models, provider, modelId } = createWorkerModels(this.env);
    const checkout = new WorkspaceCheckout(
      this.#github,
      this.workspace,
      (request, signal) => this.#token(request, signal),
      { trigger: config.defaultTrigger },
      (request) => this.#cloneUrl(request),
      () => sqliteBytes(this.ctx.storage),
      async (stats) => {
        await this.ctx.storage.put("dureview:clone", stats);
      },
    );
    const { extension, task } = createReviewRuntime({
      checkout,
      github: this.#github,
      provider,
      modelId,
      thinking: config.thinking,
      files: new WorkspaceRepoFs(this.workspace.fs),
      hooks: this.#hooks(),
      onFinished: (event) => memoryReviews.finish(event),
    });
    const registry = createRegistry();
    registry.install(extension);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          extensions: [extension],
          toolExecution: "sequential",
          compaction: { enabled: false },
          retry: { maxRetries: 2 },
        },
        onReport: (error) => {
          log("error", "durable task error", { error: error instanceof Error ? error.message : String(error) });
        },
      },
      context,
    );
    this.#pi = harness;
    this.#service = DureviewService.attach(harness, ROOT_CONVERSATION_ID, task, {
      config,
      github: this.#github,
      reviews: memoryReviews,
    });
    return harness;
  }

  #hooks() {
    if (this.env.DUREVIEW_TEST_HOOKS !== "1") return undefined;
    return {
      beforePost: async (context: Context) => {
        if ((await this.ctx.storage.get<boolean>("dureview:pause")) !== true) return;
        await this.ctx.storage.put("dureview:postEntered", true);
        await hangUntilAbort(context);
      },
    };
  }

  async #cloneUrl(request: ReviewRequest): Promise<string> {
    if (this.env.DUREVIEW_TEST_HOOKS !== "1") return request.cloneUrl;
    let base = await this.ctx.storage.get<string>("dureview:gitBase");
    if (!base) base = this.env.GIT_CLONE_BASE;
    if (!base) return request.cloneUrl;
    await this.ctx.storage.put("dureview:gitBase", base);
    return `${base.replace(/\/$/, "")}/${request.owner}/${request.repo}.git`;
  }

  #token(request: ReviewRequest, signal: AbortSignal): Promise<string | undefined> {
    if (this.#github instanceof GithubRest) return this.#github.accessToken(request, signal);
    const token = this.env.GITHUB_TOKEN?.trim();
    return Promise.resolve(token ? token : undefined);
  }

  async #readTask(taskId: number): Promise<{ task: Inspection["task"]; toolText: string }> {
    const pi = this.#pi;
    if (!pi) return { task: { status: "unopened" }, toolText: "" };
    const record = await pi.getTask(taskId as never, BACKGROUND_CONTEXT);
    if (!record) return { task: { status: "missing" }, toolText: "" };
    if (record.state.status !== "terminal") return { task: { status: record.state.status }, toolText: "" };
    const outcome = record.state.outcome;
    if (outcome.status !== "completed") {
      const error = outcome.status === "failed" ? outcome.error.message : outcome.status;
      return { task: { status: outcome.status, error }, toolText: "" };
    }
    const conversationId = conversationIdOf(outcome.result);
    if (conversationId === undefined) return { task: { status: "completed" }, toolText: "" };
    const conversation = await pi.conversation(conversationId as never, BACKGROUND_CONTEXT);
    if (!conversation) return { task: { status: "completed" }, toolText: "" };
    const entries = await conversation.entries({ order: "ascending" }, 40, undefined, BACKGROUND_CONTEXT);
    const toolText = entries.items
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
      .join("\n");
    return { task: { status: "completed" }, toolText };
  }

  #assertTest(): void {
    if (this.env.DUREVIEW_TEST_HOOKS !== "1") throw new Error("test hooks are disabled");
  }
}

function createGithub(env: Env): GitHub {
  if (env.DUREVIEW_TEST_HOOKS === "1" && env.GITHUB_MODE === "memory") return new MemoryGitHub();
  return new GithubRest(workerConfig(env));
}

function sqliteBytes(storage: DurableObjectStorage): number {
  if (typeof storage.sql.databaseSize === "number") return storage.sql.databaseSize;
  try {
    const rows = [...storage.sql.exec("SELECT SUM(pgsize) AS bytes FROM dbstat")];
    const value = rows[0]?.bytes;
    return typeof value === "number" ? value : Number(value ?? 0);
  } catch {
    return 0;
  }
}

function conversationIdOf(result: unknown): string | number | undefined {
  if (typeof result !== "object" || result === null || !("conversationId" in result)) return undefined;
  const id = result.conversationId;
  if (typeof id === "string" || typeof id === "number") return id;
  return undefined;
}

function hangUntilAbort(context: Context): Promise<void> {
  const signal = context.abortSignal;
  if (!signal) return Promise.reject(new Error("review invocation has no abort signal"));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}
