import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitCheckout } from "../src/review/checkout.js";
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
});

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
