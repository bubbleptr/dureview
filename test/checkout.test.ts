import { spawn } from "node:child_process";
import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutProtectionKey, GitCheckout } from "../src/review/checkout.js";
import { BASE_SHA, MemoryGitHub, reviewRequest, tempDataDir } from "./support.js";

describe("base branch .dureview.md", () => {
  it("uses the base branch file and ignores the pull request head", async () => {
    const sha = await commitCheckout();
    const root = await tempDataDir();
    const destination = join(root, "acme", "demo", sha.sha);
    await mkdir(join(root, "acme", "demo"), { recursive: true });
    await rename(sha.dir, destination);
    await writeFile(
      join(destination, ".dureview.md"),
      "---\ntrigger: auto\ndrafts: true\n---\n\nRules from the pull request head.\n",
    );

    const github = new MemoryGitHub();
    github.files.set(
      "main\0.dureview.md",
      "---\ntrigger: manual\nlanguage: zh\n---\n\nRules from the base branch.\n",
    );
    const checkout = new GitCheckout(github, root, async () => undefined);
    const request = reviewRequest(sha.sha);
    const prepared = await checkout.prepare(request, AbortSignal.timeout(15_000));

    expect(github.fileRefs).toEqual(["main"]);
    expect(prepared.policy.trigger).toBe("manual");
    expect(prepared.policy.language).toBe("zh");
    expect(prepared.policy.drafts).toBe(false);
    expect(prepared.rules).toContain("Rules from the base branch.");
    expect(prepared.rules).not.toContain("pull request head");
  });

  it("uses the built-in policy when the base branch has no .dureview.md", async () => {
    const sha = await commitCheckout();
    const root = await tempDataDir();
    await mkdir(join(root, "acme", "demo"), { recursive: true });
    const destination = join(root, "acme", "demo", sha.sha);
    await rename(sha.dir, destination);
    await writeFile(join(destination, ".dureview.md"), "---\ntrigger: manual\n---\n\nHead rules.\n");

    const github = new MemoryGitHub();
    const checkout = new GitCheckout(github, root, async () => undefined);
    const prepared = await checkout.prepare({ ...reviewRequest(sha.sha), baseSha: BASE_SHA }, AbortSignal.timeout(15_000));

    expect(prepared.policy.trigger).toBe("manual");
    expect(prepared.rules).toBeNull();
  });

  it("uses the server default trigger when the base branch omits it", async () => {
    const sha = await commitCheckout();
    const root = await tempDataDir();
    await mkdir(join(root, "acme", "demo"), { recursive: true });
    const destination = join(root, "acme", "demo", sha.sha);
    await rename(sha.dir, destination);

    const github = new MemoryGitHub();
    github.files.set("main\0.dureview.md", "---\nlanguage: zh\n---\nRules without a trigger.\n");
    const checkout = new GitCheckout(github, root, async () => undefined, { trigger: "once" });
    const prepared = await checkout.prepare(reviewRequest(sha.sha), AbortSignal.timeout(15_000));

    expect(prepared.policy.trigger).toBe("once");
    expect(prepared.policy.language).toBe("zh");
    expect(prepared.rules).toContain("Rules without a trigger.");
  });

  it("shallow-fetches the base commit into the head checkout", async () => {
    const parent = await tempDataDir();
    const remote = join(parent, "remote.git");
    const work = join(parent, "work");
    await git(parent, ["init", "--bare", "-b", "main", remote]);
    await git(remote, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
    await git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    await mkdir(join(work, "src"), { recursive: true });
    await git(work, ["init", "-b", "main"]);
    await writeFile(join(work, "src", "pay.ts"), "export const price = 1;\n");
    await git(work, ["add", "src/pay.ts"]);
    await git(work, ["commit", "-m", "base"]);
    const baseSha = (await git(work, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(work, "src", "pay.ts"), "export const price = 2;\n");
    await git(work, ["add", "src/pay.ts"]);
    await git(work, ["commit", "-m", "head"]);
    const headSha = (await git(work, ["rev-parse", "HEAD"])).trim();
    await git(work, ["remote", "add", "origin", remote]);
    await git(work, ["push", "origin", "HEAD:refs/heads/main"]);
    await git(work, ["push", "origin", `HEAD:refs/pull/7/head`]);

    const root = await tempDataDir();
    const checkout = new GitCheckout(new MemoryGitHub(), root, async () => undefined);
    const prepared = await checkout.prepare(
      { ...reviewRequest(headSha), baseSha, cloneUrl: remote },
      AbortSignal.timeout(20_000),
    );

    expect((await git(prepared.dir, ["rev-parse", "HEAD"])).trim()).toBe(headSha);
    expect((await git(prepared.dir, ["rev-parse", "refs/dureview/base"])).trim()).toBe(baseSha);
    expect(await git(prepared.dir, ["show", `${baseSha}:src/pay.ts`])).toBe("export const price = 1;\n");
    expect(await git(prepared.dir, ["show", `${headSha}:src/pay.ts`])).toBe("export const price = 2;\n");
  });
});

describe("checkout lifetime", () => {
  it("keeps the tree while another task of the same SHA still holds it", async () => {
    const root = await tempDataDir();
    const sha = await seedMatchingCheckout(root);
    const request = reviewRequest(sha);
    const dir = join(root, "acme", "demo", sha);
    const github = new MemoryGitHub();
    let releaseDiff = () => {};
    const diffGate = new Promise<void>((resolve) => {
      releaseDiff = resolve;
    });
    let markDiff = () => {};
    const diffWaiting = new Promise<void>((resolve) => {
      markDiff = resolve;
    });
    let opened = false;
    github.getPullDiff = async () => {
      if (!opened) {
        opened = true;
        markDiff();
      }
      await diffGate;
      return "diff";
    };
    const checkout = new GitCheckout(github, root, async () => undefined);
    const signal = AbortSignal.timeout(15_000);
    const first = checkout.prepare(request, signal, "task-a");
    await diffWaiting;
    const second = checkout.prepare(request, signal, "task-b");
    expect(await checkout.release({ request, taskId: "task-c", activeKeys: new Set() })).toBe(false);
    await expect(stat(dir)).resolves.toBeTruthy();
    releaseDiff();
    await Promise.all([first, second]);
    expect(await checkout.release({ request, taskId: "task-a", activeKeys: new Set() })).toBe(false);
    await expect(stat(dir)).resolves.toBeTruthy();
    expect(await checkout.release({ request, taskId: "task-b", activeKeys: new Set() })).toBe(true);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("keeps a checkout a running task still needs when this process has no hold", async () => {
    const root = await tempDataDir();
    const sha = await seedMatchingCheckout(root);
    const request = reviewRequest(sha);
    const dir = join(root, "acme", "demo", sha);
    const github = new MemoryGitHub();
    const checkout = new GitCheckout(github, root, async () => undefined);
    await checkout.prepare(request, AbortSignal.timeout(15_000), "task-a");
    const restarted = new GitCheckout(github, root, async () => undefined);
    const key = checkoutProtectionKey("acme", "demo", sha);

    expect(await restarted.release({ request, taskId: "task-a", activeKeys: new Set([key]) })).toBe(false);
    await expect(stat(dir)).resolves.toBeTruthy();
    expect(await restarted.release({ request, taskId: "task-a", activeKeys: new Set() })).toBe(true);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("fails with disk full instead of waiting when git runs out of space", async () => {
    const root = await tempDataDir();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\necho 'fatal: No space left on device' >&2\nsleep 60\nexit 128\n");
    await chmod(join(bin, "git"), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${bin}:${previous ?? ""}`;
    const started = Date.now();
    try {
      const checkout = new GitCheckout(new MemoryGitHub(), join(root, "checkouts"), async () => undefined);
      await expect(checkout.prepare(reviewRequest(), AbortSignal.timeout(15_000), "task-disk")).rejects.toThrow(
        /disk full/,
      );
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      process.env.PATH = previous;
    }
  });
});

async function seedMatchingCheckout(root: string): Promise<string> {
  const dir = join(root, "seed");
  await mkdir(join(dir, "src"), { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  await writeFile(join(dir, "src", "pay.ts"), "export const price = 1;\n");
  await git(dir, ["add", "src/pay.ts"]);
  await git(dir, ["commit", "-m", "init"]);
  const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  await mkdir(join(root, "acme", "demo"), { recursive: true });
  await rename(dir, join(root, "acme", "demo", sha));
  return sha;
}

async function commitCheckout(): Promise<{ dir: string; sha: string }> {
  const parent = await tempDataDir();
  const dir = join(parent, "repo");
  await mkdir(dir);
  await git(dir, ["init", "-b", "main"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await git(dir, ["add", "README.md"]);
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
