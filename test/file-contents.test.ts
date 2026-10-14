import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CHECKOUT_FILE_BYTES } from "../src/review/checkout.js";
import { toDiffFiles } from "../src/ui/diff-files.js";
import { loadReviewFilePair } from "../src/ui/file-contents.js";
import { MemoryGitHub, tempDataDir } from "./support.js";

describe("review file contents", () => {
  it("reads both sides from the local checkout and does not call GitHub", async () => {
    const root = await tempDataDir();
    const { head, base } = await commitPair(root, {
      base: { "src/pay.ts": "old line\n" },
      head: { "src/pay.ts": "new line\n" },
    });
    let called = false;
    const loaded = await loadReviewFilePair({
      checkoutRoot: root,
      github: {
        getRepoFile: async () => {
          called = true;
          return "from github\n";
        },
      },
      owner: "acme",
      repo: "demo",
      installationId: null,
      sha: head,
      baseSha: base,
      path: "src/pay.ts",
      previousPath: null,
      signal: AbortSignal.timeout(15_000),
    });
    expect(called).toBe(false);
    expect(loaded).toEqual({ kind: "files", oldText: "old line\n", newText: "new line\n" });
  });

  it("reads a rename from the previous path at the base commit", async () => {
    const root = await tempDataDir();
    const { head, base } = await commitPair(root, {
      base: { "old/name.ts": "before\n" },
      head: { "new/name.ts": "after\n" },
    });
    const loaded = await loadReviewFilePair({
      checkoutRoot: root,
      github: { getRepoFile: async () => null },
      owner: "acme",
      repo: "demo",
      installationId: null,
      sha: head,
      baseSha: base,
      path: "new/name.ts",
      previousPath: "old/name.ts",
      signal: AbortSignal.timeout(15_000),
    });
    expect(loaded).toEqual({ kind: "files", oldText: "before\n", newText: "after\n" });
    expect(toDiffFiles({ type: "rename-changed", name: "new/name.ts", prevName: "old/name.ts" }, loaded.kind === "files" ? loaded : { oldText: null, newText: null })).toEqual({
      oldFile: { name: "old/name.ts", contents: "before\n" },
      newFile: { name: "new/name.ts", contents: "after\n" },
    });
  });

  it("keeps a missing base side for an added file", async () => {
    const root = await tempDataDir();
    const { head, base } = await commitPair(root, {
      base: { "README.md": "hi\n" },
      head: { "README.md": "hi\n", "src/pay.ts": "added\n" },
    });
    const loaded = await loadReviewFilePair({
      checkoutRoot: root,
      github: { getRepoFile: async () => "should not be used\n" },
      owner: "acme",
      repo: "demo",
      installationId: null,
      sha: head,
      baseSha: base,
      path: "src/pay.ts",
      previousPath: null,
      signal: AbortSignal.timeout(15_000),
    });
    expect(loaded).toEqual({ kind: "files", oldText: null, newText: "added\n" });
    expect(toDiffFiles({ type: "change", name: "src/pay.ts" }, { oldText: null, newText: "added\n" })).toBeNull();
    expect(toDiffFiles({ type: "rename-pure", name: "src/pay.ts" }, { oldText: null, newText: "added\n" })).toEqual({
      oldFile: null,
      newFile: { name: "src/pay.ts", contents: "added\n" },
    });
  });

  it("leaves binary and oversized blobs unavailable", async () => {
    const root = await tempDataDir();
    const binary = await commitPair(root, {
      base: { "src/pay.ts": "text\n" },
      head: { "src/pay.ts": "bin\0ary" },
    });
    const hugeRoot = await tempDataDir();
    const huge = await commitPair(hugeRoot, {
      base: { "src/pay.ts": "text\n" },
      head: { "src/pay.ts": "x".repeat(CHECKOUT_FILE_BYTES + 1) },
    });
    const signal = AbortSignal.timeout(15_000);
    expect(await load("acme", root, binary, signal)).toEqual({ kind: "unavailable" });
    expect(await load("acme", hugeRoot, huge, signal)).toEqual({ kind: "unavailable" });
  });

  it("rejects path traversal", async () => {
    const loaded = await loadReviewFilePair({
      checkoutRoot: await tempDataDir(),
      github: { getRepoFile: async () => "secret\n" },
      owner: "acme",
      repo: "demo",
      installationId: null,
      sha: "a".repeat(40),
      baseSha: "b".repeat(40),
      path: "../secret",
      previousPath: null,
      signal: AbortSignal.timeout(5_000),
    });
    expect(loaded).toEqual({ kind: "unavailable" });
  });

  it("falls back to GitHub contents at the base and head SHAs", async () => {
    const github = new MemoryGitHub();
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    github.files.set(`${head}\0src/pay.ts`, "from head\n");
    github.files.set(`${base}\0src/pay.ts`, "from base\n");
    const loaded = await loadReviewFilePair({
      checkoutRoot: await tempDataDir(),
      github,
      owner: "acme",
      repo: "demo",
      installationId: 99,
      sha: head,
      baseSha: base,
      path: "src/pay.ts",
      previousPath: null,
      signal: AbortSignal.timeout(5_000),
    });
    expect(loaded).toEqual({ kind: "files", oldText: "from base\n", newText: "from head\n" });
    expect(github.fileRefs).toEqual([head, base]);
  });

  it("stays unavailable when GitHub contents fail", async () => {
    const github = new MemoryGitHub();
    const head = "c".repeat(40);
    const base = "d".repeat(40);
    const missing = await loadReviewFilePair({
      checkoutRoot: await tempDataDir(),
      github,
      owner: "acme",
      repo: "demo",
      installationId: null,
      sha: head,
      baseSha: base,
      path: "src/pay.ts",
      previousPath: null,
      signal: AbortSignal.timeout(5_000),
    });
    const failed = await loadReviewFilePair({
      checkoutRoot: await tempDataDir(),
      github: {
        getRepoFile: async () => {
          throw new Error("GitHub contents failed");
        },
      },
      owner: "acme",
      repo: "demo",
      installationId: null,
      sha: head,
      baseSha: base,
      path: "src/pay.ts",
      previousPath: null,
      signal: AbortSignal.timeout(5_000),
    });
    github.files.set(`${head}\0src/pay.ts`, `x\0y`);
    github.files.set(`${base}\0src/pay.ts`, "ok\n");
    const binary = await loadReviewFilePair({
      checkoutRoot: await tempDataDir(),
      github,
      owner: "acme",
      repo: "demo",
      installationId: null,
      sha: head,
      baseSha: base,
      path: "src/pay.ts",
      previousPath: null,
      signal: AbortSignal.timeout(5_000),
    });
    expect(missing).toEqual({ kind: "unavailable" });
    expect(failed).toEqual({ kind: "unavailable" });
    expect(binary).toEqual({ kind: "unavailable" });
  });
});

async function load(
  owner: string,
  root: string,
  commits: { head: string; base: string },
  signal: AbortSignal,
) {
  return loadReviewFilePair({
    checkoutRoot: root,
    github: { getRepoFile: async () => "unused\n" },
    owner,
    repo: "demo",
    installationId: null,
    sha: commits.head,
    baseSha: commits.base,
    path: "src/pay.ts",
    previousPath: null,
    signal,
  });
}

async function commitPair(
  root: string,
  files: { base: Record<string, string>; head: Record<string, string> },
): Promise<{ head: string; base: string }> {
  const scratch = join(root, "scratch");
  await mkdir(scratch, { recursive: true });
  await git(scratch, ["init", "-b", "main"]);
  await writeTree(scratch, files.base);
  await git(scratch, ["add", "."]);
  await git(scratch, ["commit", "-m", "base"]);
  const base = (await git(scratch, ["rev-parse", "HEAD"])).trim();
  await writeTree(scratch, files.head);
  await git(scratch, ["add", "-A"]);
  await git(scratch, ["commit", "-m", "head"]);
  const head = (await git(scratch, ["rev-parse", "HEAD"])).trim();
  const destination = join(root, "acme", "demo", head);
  await mkdir(join(root, "acme", "demo"), { recursive: true });
  const { rename } = await import("node:fs/promises");
  await rename(scratch, destination);
  return { head, base };
}

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
  }
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
