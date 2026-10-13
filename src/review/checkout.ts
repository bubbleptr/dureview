import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { GitHub } from "../github/client.js";
import type { ReviewRequest } from "../types.js";
import { truncateDiff } from "./diff.js";
import { parseDureviewDocument, type ReviewPolicy, defaultPolicy } from "./policy.js";

export type Checkout = {
  dir: string;
  diff: string;
  truncated: boolean;
  rules: string | null;
  policy: ReviewPolicy;
};

export interface RepoCheckout {
  prepare(request: ReviewRequest, signal: AbortSignal): Promise<Checkout>;
}

/**
 * Fetch the pull request head into the data directory and read an optional `.dureview.md`.
 * The diff comes from GitHub so it matches the review comments' commit.
 * Reuses a directory whose HEAD is already the requested SHA.
 */
export class GitCheckout implements RepoCheckout {
  constructor(
    private readonly github: GitHub,
    private readonly root: string,
    private readonly tokenFor: (request: ReviewRequest, signal: AbortSignal) => Promise<string | undefined>,
  ) {}

  async prepare(request: ReviewRequest, signal: AbortSignal): Promise<Checkout> {
    const dir = path.join(this.root, request.owner, request.repo, request.sha);
    await mkdir(path.dirname(dir), { recursive: true });
    if (!(await headMatches(dir, request.sha, signal))) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const token = await this.tokenFor(request, signal);
      const header = token ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];
      const base = ["-c", "safe.directory=*", ...header];
      await git(dir, [...base, "init"], signal);
      await git(dir, [...base, "remote", "add", "origin", request.cloneUrl], signal);
      await git(dir, [...base, "fetch", "--depth", "1", "origin", `pull/${request.number}/head`], signal);
      await git(dir, [...base, "checkout", "--detach", "FETCH_HEAD"], signal);
      if (!(await headMatches(dir, request.sha, signal))) {
        throw new Error(`Checked out ${request.owner}/${request.repo}#${request.number} but HEAD is not ${request.sha}.`);
      }
    }
    const diffText = await this.github.getPullDiff(request, signal);
    const { diff, truncated } = truncateDiff(diffText);
    const loaded = await loadDureviewFile(dir);
    return { dir, diff, truncated, rules: loaded.rules, policy: loaded.policy };
  }
}

export async function loadDureviewFile(dir: string): Promise<{ rules: string | null; policy: ReviewPolicy }> {
  try {
    const text = await readFile(path.join(dir, ".dureview.md"), "utf8");
    return parseDureviewDocument(text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: null, policy: defaultPolicy() };
    throw error;
  }
}

async function headMatches(dir: string, sha: string, signal: AbortSignal): Promise<boolean> {
  try {
    const head = (await git(dir, ["rev-parse", "HEAD"], signal)).trim();
    return head === sha;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
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
    const onAbort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const command = args.filter((arg) => !arg.includes("AUTHORIZATION")).slice(0, 6).join(" ");
      reject(new Error(`git ${command} failed (${code}): ${stderr.slice(0, 400)}`));
    });
  });
}
