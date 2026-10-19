import { spawn } from "node:child_process";
import { cp, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupCheckouts, GitCheckout, type RepoCheckout } from "../src/review/checkout.js";
import type { ReviewRequest } from "../src/types.js";
import {
  MemoryGitHub,
  openTestService,
  reviewRequest,
  scriptedReview,
  tempDataDir,
} from "./support.js";

describe("checkout removed when the review finishes", () => {
  const closers: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it("deletes the checkout after a completed review", async () => {
    const dataDir = await tempDataDir();
    const root = join(dataDir, "checkouts");
    const template = await seedTemplate();
    const sha = template.sha;
    const github = new MemoryGitHub();
    const checkout = seededCheckout(root, template.dir, github);
    const { service } = await openTestService({
      dataDir,
      github,
      checkout,
      responses: scriptedReview("Nothing to bill twice.", []),
    });
    closers.push(() => service.close());

    const queued = await service.enqueue(reviewRequest(sha));
    const settled = await service.wait(queued.taskId);

    expect(settled.state.outcome.status).toBe("completed");
    await expectGone(checkoutDir(root, sha, queued.taskId));
  });

  it("deletes the checkout when the review fails", async () => {
    const dataDir = await tempDataDir();
    const root = join(dataDir, "checkouts");
    const template = await seedTemplate();
    const sha = template.sha;
    const github = new MemoryGitHub();
    github.getPullDiff = async () => {
      throw new Error("diff unavailable");
    };
    const checkout = seededCheckout(root, template.dir, github);
    const { service } = await openTestService({ dataDir, github, checkout, responses: [] });
    closers.push(() => service.close());

    const queued = await service.enqueue(reviewRequest(sha));
    const settled = await service.wait(queued.taskId);

    expect(settled.state.outcome.status).toBe("failed");
    if (settled.state.outcome.status === "failed") {
      expect(settled.state.outcome.error.message).toContain("diff unavailable");
    }
    await expectGone(checkoutDir(root, sha, queued.taskId));
  });

  it("deletes the checkout when the review is aborted", async () => {
    const dataDir = await tempDataDir();
    const root = join(dataDir, "checkouts");
    const template = await seedTemplate();
    const sha = template.sha;
    const github = new MemoryGitHub();
    const inner = new GitCheckout(github, root, async () => undefined);
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const checkout: RepoCheckout = {
      prepare: async (request, signal, taskId) => {
        await placeTemplate(root, request, taskId, template.dir);
        const prepared = await inner.prepare(request, signal, taskId);
        markStarted();
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        });
        return prepared;
      },
      release: (input) => inner.release(input),
    };
    const { service } = await openTestService({ dataDir, github, checkout, responses: [] });
    closers.push(() => service.close());

    const queued = await service.enqueue(reviewRequest(sha));
    await started;
    await service.harness.abortTask(queued.taskId, BACKGROUND_CONTEXT);
    const settled = await service.wait(queued.taskId);

    expect(settled.state.outcome.status).toBe("aborted");
    await expectGone(checkoutDir(root, sha, queued.taskId));
  });

  it("sweep deletes an aborted checkout and keeps a live one", async () => {
    const dataDir = await tempDataDir();
    const root = join(dataDir, "checkouts");
    const liveTemplate = await seedTemplate("export const live = 1;\n");
    const abortedTemplate = await seedTemplate("export const aborted = 2;\n");
    const github = new MemoryGitHub();
    const inner = new GitCheckout(github, root, async () => undefined);
    let markLive = () => {};
    const liveReady = new Promise<void>((resolve) => {
      markLive = resolve;
    });
    let markAborted = () => {};
    const abortedReady = new Promise<void>((resolve) => {
      markAborted = resolve;
    });
    const checkout: RepoCheckout = {
      prepare: async (request, signal, taskId) => {
        const template = request.sha === liveTemplate.sha ? liveTemplate.dir : abortedTemplate.dir;
        await placeTemplate(root, request, taskId, template);
        const prepared = await inner.prepare(request, signal, taskId);
        if (request.sha === liveTemplate.sha) markLive();
        if (request.sha === abortedTemplate.sha) markAborted();
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        });
        return prepared;
      },
      release: (input) => inner.release(input),
    };
    const { service } = await openTestService({ dataDir, github, checkout, responses: [] });
    closers.push(() => service.close());

    const live = await service.enqueue(reviewRequest(liveTemplate.sha));
    const aborted = await service.enqueue(reviewRequest(abortedTemplate.sha));
    await liveReady;
    await abortedReady;
    await service.harness.abortTask(aborted.taskId, BACKGROUND_CONTEXT);
    const settled = await service.wait(aborted.taskId);

    expect(settled.state.outcome.status).toBe("aborted");
    expect(await service.checkoutTaskIsLive(String(aborted.taskId))).toBe(false);
    expect(await service.checkoutTaskIsLive(String(live.taskId))).toBe(true);
    expect((await service.savedReview(String(aborted.taskId)))?.outcome).toBe("running");

    const abortedDir = checkoutDir(root, abortedTemplate.sha, aborted.taskId);
    const liveDir = checkoutDir(root, liveTemplate.sha, live.taskId);
    await expectGone(abortedDir);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await mkdir(abortedDir, { recursive: true });
    await writeFile(join(abortedDir, "blob"), "x");
    await utimes(abortedDir, old, old);
    await utimes(liveDir, old, old);

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      maxBytes: 1,
      taskIsLive: (taskId) => service.checkoutTaskIsLive(taskId),
    });

    expect(removed).toContain(`acme/demo/${abortedTemplate.sha}-${aborted.taskId}`);
    await expect(stat(abortedDir)).rejects.toThrow();
    await expect(stat(liveDir)).resolves.toBeTruthy();
  });

  it("keeps a legacy checkout while a live task of that sha is running", async () => {
    const dataDir = await tempDataDir();
    const root = join(dataDir, "checkouts");
    const template = await seedTemplate("export const legacy = 1;\n");
    const github = new MemoryGitHub();
    const inner = new GitCheckout(github, root, async () => undefined);
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const checkout: RepoCheckout = {
      prepare: async (request, signal, taskId) => {
        await placeTemplate(root, request, taskId, template.dir);
        const prepared = await inner.prepare(request, signal, taskId);
        markStarted();
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        });
        return prepared;
      },
      release: (input) => inner.release(input),
    };
    const { service } = await openTestService({ dataDir, github, checkout, responses: [] });
    closers.push(() => service.close());

    const queued = await service.enqueue(reviewRequest(template.sha));
    await started;
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const legacy = join(root, "acme", "demo", template.sha);
    const otherSha = "b".repeat(40);
    const other = join(root, "acme", "demo", otherSha);
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "blob"), "keep");
    await utimes(legacy, old, old);
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "blob"), "drop");
    await utimes(other, old, old);

    const sweep = () =>
      cleanupCheckouts({
        root,
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        maxBytes: 1,
        taskIsLive: (taskId) => service.checkoutTaskIsLive(taskId),
        legacyIsLive: (candidate) => service.legacyCheckoutIsLive(candidate),
      });
    const removed = await sweep();

    expect(removed).toContain(`acme/demo/${otherSha}`);
    await expect(stat(legacy)).resolves.toBeTruthy();
    await expect(stat(other)).rejects.toThrow();

    await service.harness.abortTask(queued.taskId, BACKGROUND_CONTEXT);
    const settled = await service.wait(queued.taskId);
    expect(settled.state.outcome.status).toBe("aborted");
    const removedAfter = await sweep();
    expect(removedAfter).toContain(`acme/demo/${template.sha}`);
    await expect(stat(legacy)).rejects.toThrow();
  });
});

function checkoutDir(root: string, sha: string, taskId: string | number): string {
  return join(root, "acme", "demo", `${sha}-${taskId}`);
}

async function placeTemplate(
  root: string,
  request: ReviewRequest,
  taskId: string | undefined,
  template: string,
): Promise<void> {
  const dir = join(root, request.owner, request.repo, taskId ? `${request.sha}-${taskId}` : request.sha);
  await mkdir(join(root, request.owner, request.repo), { recursive: true });
  try {
    await stat(dir);
  } catch {
    await cp(template, dir, { recursive: true });
  }
}

async function expectGone(dir: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await stat(dir);
          return "present";
        } catch {
          return "gone";
        }
      },
      { timeout: 2_000, interval: 10 },
    )
    .toBe("gone");
}

function seededCheckout(root: string, template: string, github: MemoryGitHub): RepoCheckout {
  const inner = new GitCheckout(github, root, async () => undefined);
  return {
    prepare: async (request, signal, taskId) => {
      await placeTemplate(root, request, taskId, template);
      return inner.prepare(request, signal, taskId);
    },
    release: (input) => inner.release(input),
  };
}

async function seedTemplate(
  body = "export function charge(amount: number) { return amount; }\n",
): Promise<{ dir: string; sha: string }> {
  const parent = await tempDataDir();
  const dir = join(parent, "seed");
  await mkdir(join(dir, "src"), { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await writeFile(join(dir, "src", "pay.ts"), body);
  await git(dir, ["add", "src/pay.ts"]);
  await git(dir, ["commit", "-m", "init"]);
  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return { dir, sha };
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "dureview",
        GIT_AUTHOR_EMAIL: "dureview@example.com",
        GIT_COMMITTER_NAME: "dureview",
        GIT_COMMITTER_EMAIL: "dureview@example.com",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}
