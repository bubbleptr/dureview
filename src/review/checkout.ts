import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import type { GitHub } from "../github/client.js";
import type { ReviewRequest } from "../types.js";
import { truncateDiff } from "./diff.js";
import { parseDureviewDocument, type PolicyDefaults, type ReviewPolicy, defaultPolicy } from "./policy.js";

/** Same ceiling as the review grep skip: larger blobs stay hunk-only in the diff. */
export const CHECKOUT_FILE_BYTES = 512 * 1024;

const SHA = /^[0-9a-fA-F]{7,64}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export type CheckoutFile =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "blocked" };

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
 * Fetch the pull request head into the data directory and read `.dureview.md` from the base branch.
 * The file is not taken from the pull request head, so the pull request cannot change its trigger
 * rules, thresholds, or prompt. The diff comes from GitHub so it matches the review comments' commit.
 * Reuses a directory whose HEAD is already the requested SHA.
 * The base commit is fetched into the same directory as `refs/dureview/base`, so `git show <sha>:<path>`
 * can read either side. A directory that already has the head but has no `origin` remote is left as-is.
 */
export class GitCheckout implements RepoCheckout {
  constructor(
    private readonly github: GitHub,
    private readonly root: string,
    private readonly tokenFor: (request: ReviewRequest, signal: AbortSignal) => Promise<string | undefined>,
    private readonly policyDefaults: PolicyDefaults = {},
  ) {}

  async prepare(request: ReviewRequest, signal: AbortSignal): Promise<Checkout> {
    const dir = path.join(this.root, request.owner, request.repo, request.sha);
    await mkdir(path.dirname(dir), { recursive: true });
    let header: string[] | undefined;
    if (!(await headMatches(dir, request.sha, signal))) {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      const token = await this.tokenFor(request, signal);
      header = authHeader(token);
      await git(dir, ["init"], signal);
      await git(dir, ["remote", "add", "origin", request.cloneUrl], signal);
      await git(dir, [...header, ...fileProtocolArgs(request.cloneUrl), "fetch", "--depth", "1", "origin", `pull/${request.number}/head`], signal);
      await git(dir, ["checkout", "--detach", "FETCH_HEAD"], signal);
      if (!(await headMatches(dir, request.sha, signal))) {
        throw new Error(`Checked out ${request.owner}/${request.repo}#${request.number} but HEAD is not ${request.sha}.`);
      }
    }
    await ensureBaseCommit(dir, request, header, this.tokenFor, signal);
    await utimes(dir, new Date(), new Date());
    const diffText = await this.github.getPullDiff(request, signal);
    const { diff, truncated } = truncateDiff(diffText);
    const loaded = await readBaseDureview(this.github, request, signal, this.policyDefaults);
    return { dir, diff, truncated, rules: loaded.rules, policy: loaded.policy };
  }
}

/**
 * Load `.dureview.md` from the pull request base branch.
 * A missing file uses the built-in policy. `trigger` falls back to `defaults.trigger`,
 * then `manual`, including when the file exists and omits the key.
 * The pull request head is not consulted.
 */
export async function readBaseDureview(
  github: GitHub,
  request: Pick<ReviewRequest, "owner" | "repo" | "installationId" | "baseRef">,
  signal: AbortSignal,
  defaults: PolicyDefaults = {},
): Promise<{ rules: string | null; policy: ReviewPolicy }> {
  const text = await github.getRepoFile(request, ".dureview.md", request.baseRef, signal);
  if (text === null) return { rules: null, policy: defaultPolicy(defaults) };
  return parseDureviewDocument(text, defaults);
}

export async function loadDureviewFile(
  dir: string,
  defaults: PolicyDefaults = {},
): Promise<{ rules: string | null; policy: ReviewPolicy }> {
  try {
    const text = await readFile(path.join(dir, ".dureview.md"), "utf8");
    return parseDureviewDocument(text, defaults);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: null, policy: defaultPolicy(defaults) };
    throw error;
  }
}

/** `owner/repo/sha` under the checkouts root, or null when a segment is not a single safe name. */
export function checkoutDirectory(root: string, owner: string, repo: string, sha: string): string | null {
  if (!safeSegment(owner) || !safeSegment(repo) || !SHA.test(sha)) return null;
  return path.join(root, owner, repo, sha);
}

/** Key for a checkout that a running review still needs. */
export function checkoutProtectionKey(owner: string, repo: string, sha: string): string {
  return `${owner}\0${repo}\0${sha}`;
}

/**
 * Relative path inside a repository. Rejects traversal, absolute paths, and leading dashes
 * so the value can be passed to `git show <sha>:<path>`.
 */
export function safeRepoPath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false;
  if (value.startsWith("/") || value.startsWith("-") || value.includes("\\") || value.includes("\0")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("-") && !/[\r\n]/.test(part));
}

export async function checkoutCommitExists(dir: string, sha: string, signal: AbortSignal): Promise<boolean> {
  if (!SHA.test(sha)) return false;
  try {
    await git(dir, ["cat-file", "-e", `${sha}^{commit}`], signal);
    return true;
  } catch {
    return false;
  }
}

/** Read one blob. `blocked` is a binary file or one past {@link CHECKOUT_FILE_BYTES}. */
export async function readCheckoutFile(dir: string, sha: string, filePath: string, signal: AbortSignal): Promise<CheckoutFile> {
  if (!SHA.test(sha) || !safeRepoPath(filePath)) return { kind: "blocked" };
  const spec = `${sha}:${filePath}`;
  let size: number;
  try {
    size = Number((await git(dir, ["cat-file", "-s", spec], signal)).trim());
  } catch {
    return { kind: "missing" };
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > CHECKOUT_FILE_BYTES) return { kind: "blocked" };
  const text = await git(dir, ["show", spec], signal);
  if (text.includes("\0")) return { kind: "blocked" };
  return { kind: "text", text };
}

/**
 * Delete `<root>/<owner>/<repo>/<sha>` directories whose mtime is at least `ttlMs` old.
 * `protectedKeys` are {@link checkoutProtectionKey} values for reviews that are still running.
 * Symlinks are left in place. Missing roots delete nothing.
 */
export async function cleanupCheckouts(input: {
  root: string;
  ttlMs: number;
  now?: number;
  protectedKeys: ReadonlySet<string>;
}): Promise<string[]> {
  const now = input.now ?? Date.now();
  const removed: string[] = [];
  const owners = await childDirectories(input.root);
  for (const owner of owners) {
    const repos = await childDirectories(path.join(input.root, owner));
    for (const repo of repos) {
      const shas = await childDirectories(path.join(input.root, owner, repo));
      for (const sha of shas) {
        if (input.protectedKeys.has(checkoutProtectionKey(owner, repo, sha))) continue;
        const full = path.join(input.root, owner, repo, sha);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(full)).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtimeMs < input.ttlMs) continue;
        try {
          await rm(full, { recursive: true, force: true });
          removed.push(`${owner}/${repo}/${sha}`);
        } catch {
          // The next sweep retries a directory that is busy.
        }
      }
    }
  }
  return removed;
}

async function childDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function ensureBaseCommit(
  dir: string,
  request: ReviewRequest,
  knownHeader: string[] | undefined,
  tokenFor: (request: ReviewRequest, signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<void> {
  const baseSha = request.baseSha.trim();
  if (!SHA.test(baseSha)) return;
  if (await checkoutCommitExists(dir, baseSha, signal)) {
    await git(dir, ["update-ref", "refs/dureview/base", baseSha], signal);
    return;
  }
  const origin = await originUrl(dir, signal);
  if (!origin) return;
  const header = knownHeader ?? authHeader(await tokenFor(request, signal));
  await git(dir, [...header, ...fileProtocolArgs(origin), "fetch", "--depth", "1", "origin", baseSha], signal);
  if (!(await checkoutCommitExists(dir, baseSha, signal))) {
    throw new Error(`Fetched ${request.owner}/${request.repo} but base ${baseSha} is not in the checkout.`);
  }
  await git(dir, ["update-ref", "refs/dureview/base", baseSha], signal);
}

async function originUrl(dir: string, signal: AbortSignal): Promise<string | null> {
  try {
    const url = (await git(dir, ["remote", "get-url", "origin"], signal)).trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

function authHeader(token: string | undefined): string[] {
  if (!token) return [];
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`];
}

function fileProtocolArgs(url: string): string[] {
  if (url.startsWith("file:") || url.startsWith("/")) return ["-c", "protocol.file.allow=always"];
  return [];
}

function safeSegment(value: string): boolean {
  return SEGMENT.test(value) && value !== "." && value !== "..";
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
    const child = spawn("git", ["-c", "safe.directory=*", ...args], {
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
