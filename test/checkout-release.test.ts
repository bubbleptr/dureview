import { spawn } from "node:child_process";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { GitCheckout, type RepoCheckout } from "../src/review/checkout.js";
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
    const sha = await seedCheckout(root);
    const github = new MemoryGitHub();
    const checkout = new GitCheckout(github, root, async () => undefined);
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
    await expectGone(join(root, "acme", "demo", sha));
  });

  it("deletes the checkout when the review fails", async () => {
    const dataDir = await tempDataDir();
    const root = join(dataDir, "checkouts");
    const sha = await seedCheckout(root);
    const github = new MemoryGitHub();
    github.getPullDiff = async () => {
      throw new Error("diff unavailable");
    };
    const checkout = new GitCheckout(github, root, async () => undefined);
    const { service } = await openTestService({ dataDir, github, checkout, responses: [] });
    closers.push(() => service.close());

    const queued = await service.enqueue(reviewRequest(sha));
    const settled = await service.wait(queued.taskId);

    expect(settled.state.outcome.status).toBe("failed");
    if (settled.state.outcome.status === "failed") {
      expect(settled.state.outcome.error.message).toContain("diff unavailable");
    }
    await expectGone(join(root, "acme", "demo", sha));
  });

  it("deletes the checkout when the review is aborted", async () => {
    const dataDir = await tempDataDir();
    const root = join(dataDir, "checkouts");
    const sha = await seedCheckout(root);
    const github = new MemoryGitHub();
    const inner = new GitCheckout(github, root, async () => undefined);
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const checkout: RepoCheckout = {
      prepare: async (request, signal, taskId) => {
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
    await expectGone(join(root, "acme", "demo", sha));
  });
});

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

async function seedCheckout(root: string): Promise<string> {
  const dir = join(root, "seed");
  await mkdir(join(dir, "src"), { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await writeFile(join(dir, "src", "pay.ts"), "export function charge(amount: number) { return amount; }\n");
  await git(dir, ["add", "src/pay.ts"]);
  await git(dir, ["commit", "-m", "init"]);
  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  await mkdir(join(root, "acme", "demo"), { recursive: true });
  await rename(dir, join(root, "acme", "demo", sha));
  return sha;
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
