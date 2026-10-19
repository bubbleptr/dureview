import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import type { GitHub } from "../github/client.js";
import type { ReviewRequest } from "../types.js";
import { truncateDiff } from "./diff.js";
import { parseDureviewDocument, type PolicyDefaults, type ReviewPolicy, defaultPolicy } from "./policy.js";

/** Same ceiling as the review grep skip: larger blobs stay hunk-only in the diff. */
export const CHECKOUT_FILE_BYTES = 512 * 1024;

/** Unused checkouts older than this are removed by the sweep even when the TTL is longer. */
export const CHECKOUT_BACKSTOP_MS = 60 * 60 * 1000;

const SHA = /^[0-9a-fA-F]{7,64}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CHECKOUT_DIR = /^([0-9a-fA-F]{7,64})(?:-([A-Za-z0-9_-]{1,64}))?$/;

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
  prepare(request: ReviewRequest, signal: AbortSignal, taskId?: string): Promise<Checkout>;
  release?(input: { request: ReviewRequest; taskId: string }): Promise<boolean>;
}

/**
 * Fetch the pull request head into the data directory and read `.dureview.md` from the base branch.
 * The file is not taken from the pull request head, so the pull request cannot change its trigger
 * rules, thresholds, or prompt. The diff comes from GitHub so it matches the review comments' commit.
 * Reuses this task's directory when its HEAD is already the requested SHA.
 * The base commit is fetched into the same directory as `refs/dureview/base`, so `git show <sha>:<path>`
 * can read either side. A directory that already has the head but has no `origin` remote is left as-is.
 */
export class GitCheckout implements RepoCheckout {
  constructor(
    private readonly github: GitHub,
    private readonly root: string,
    private readonly tokenFor: (request: ReviewRequest, signal: AbortSignal) => Promise<string | undefined>,
    private readonly policyDefaults: PolicyDefaults | (() => PolicyDefaults) = {},
  ) {}

  async prepare(request: ReviewRequest, signal: AbortSignal, taskId?: string): Promise<Checkout> {
    const dir = checkoutDirectory(this.root, request.owner, request.repo, request.sha, taskId);
    if (!dir) throw new Error(`Invalid checkout path for ${request.owner}/${request.repo}.`);
    try {
      await mkdir(path.dirname(dir), { recursive: true });
      let header: string[] | undefined;
      if (!(await headMatches(dir, request.sha, signal))) {
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        const token = await this.tokenFor(request, signal);
        header = authHeader(token);
        await git(dir, ["init"], signal);
        await git(dir, ["remote", "add", "origin", request.cloneUrl], signal);
        await git(
          dir,
          [...header, ...fileProtocolArgs(request.cloneUrl), "fetch", "--depth", "1", "origin", `pull/${request.number}/head`],
          signal,
        );
        await git(dir, ["checkout", "--detach", "FETCH_HEAD"], signal);
        if (!(await headMatches(dir, request.sha, signal))) {
          throw new Error(`Checked out ${request.owner}/${request.repo}#${request.number} but HEAD is not ${request.sha}.`);
        }
      }
      await ensureBaseCommit(dir, request, header, this.tokenFor, signal);
      await utimes(dir, new Date(), new Date());
    } catch (error) {
      if (signal.aborted) throw error;
      if (!isDiskFull(error)) throw error;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error("disk full");
    }
    const diffText = await this.github.getPullDiff(request, signal);
    const { diff, truncated } = truncateDiff(diffText);
    const loaded = await readBaseDureview(this.github, request, signal, this.#defaults());
    return { dir, diff, truncated, rules: loaded.rules, policy: loaded.policy };
  }

  async release(input: { request: ReviewRequest; taskId: string }): Promise<boolean> {
    const dir = checkoutDirectory(this.root, input.request.owner, input.request.repo, input.request.sha, input.taskId);
    if (!dir) return false;
    try {
      await stat(dir);
    } catch {
      return false;
    }
    await rm(dir, { recursive: true, force: true });
    return true;
  }

  #defaults(): PolicyDefaults {
    return typeof this.policyDefaults === "function" ? this.policyDefaults() : this.policyDefaults;
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

/**
 * This task's checkout, `owner/repo/<sha>-<taskId>`, or `owner/repo/<sha>` when `taskId` is omitted.
 * Null when a segment is not a single safe name.
 */
export function checkoutDirectory(
  root: string,
  owner: string,
  repo: string,
  sha: string,
  taskId?: string,
): string | null {
  if (!safeSegment(owner) || !safeSegment(repo) || !SHA.test(sha)) return null;
  if (taskId === undefined) return path.join(root, owner, repo, sha);
  if (!TASK_ID.test(taskId)) return null;
  return path.join(root, owner, repo, `${sha}-${taskId}`);
}

/** An aborted task is terminal, so it does not keep a checkout. */
export function taskStatusIsLive(status: string | undefined): boolean {
  return status !== undefined && status !== "terminal";
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

export type LegacyCheckout = {
  owner: string;
  repo: string;
  sha: string;
  full: string;
};

export function taskUsesLegacyCheckout(
  task: { readonly input: unknown; readonly state: { readonly status: string; readonly checkpoint?: unknown } },
  checkout: LegacyCheckout,
): boolean {
  if (
    task.state.status !== "pending" &&
    task.state.status !== "running" &&
    task.state.status !== "waiting" &&
    task.state.status !== "completing"
  ) {
    return false;
  }
  const identity = reviewIdentity(task.input);
  if (identity?.owner === checkout.owner && identity.repo === checkout.repo && identity.sha === checkout.sha) return true;
  const cwd = recordedCheckoutDir(task.state.checkpoint);
  return cwd !== undefined && path.resolve(cwd) === path.resolve(checkout.full);
}

function reviewIdentity(value: unknown): { owner: string; repo: string; sha: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (!("owner" in value) || !("repo" in value) || !("sha" in value)) return undefined;
  const { owner, repo, sha } = value;
  if (typeof owner !== "string" || typeof repo !== "string" || typeof sha !== "string") return undefined;
  return { owner, repo, sha };
}

function recordedCheckoutDir(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("checkoutDir" in value)) return undefined;
  return typeof value.checkoutDir === "string" ? value.checkoutDir : undefined;
}

type CheckoutLeaf = {
  label: string;
  full: string;
  mtimeMs: number;
  bytes: number;
  taskId: string | null;
  legacy: LegacyCheckout | null;
};

/**
 * Delete `<root>/<owner>/<repo>/<sha>` and `<root>/<owner>/<repo>/<sha>-<taskId>` directories.
 * A checkout goes when it is at least `ttlMs` old, or at least {@link CHECKOUT_BACKSTOP_MS} old.
 * When `maxBytes` is set and the tree is still larger, the oldest checkouts go first.
 * `taskIsLive` is read for that directory's task immediately before each delete.
 * A terminal task, including an aborted one, does not keep its directory.
 * A `<sha>` directory from the previous layout is kept only when `legacyIsLive` says a live task's cwd or sha still matches it.
 * Symlinks are left in place. Missing roots delete nothing.
 */
export async function cleanupCheckouts(input: {
  root: string;
  ttlMs: number;
  now?: number;
  maxBytes?: number;
  taskIsLive: (taskId: string) => Promise<boolean>;
  legacyIsLive?: (checkout: LegacyCheckout) => Promise<boolean>;
}): Promise<string[]> {
  const now = input.now ?? Date.now();
  const removed: string[] = [];
  const leaves = await listCheckoutLeaves(input.root);
  let total = 0;
  for (const leaf of leaves) total += leaf.bytes;
  const remaining: CheckoutLeaf[] = [];
  for (const leaf of leaves) {
    const age = now - leaf.mtimeMs;
    if (age < input.ttlMs && age < CHECKOUT_BACKSTOP_MS) {
      remaining.push(leaf);
      continue;
    }
    if (await deleteUnlessLive(leaf, input.taskIsLive, input.legacyIsLive)) {
      removed.push(leaf.label);
      total -= leaf.bytes;
      continue;
    }
    remaining.push(leaf);
  }
  if (input.maxBytes !== undefined && total > input.maxBytes) {
    remaining.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const leaf of remaining) {
      if (total <= input.maxBytes) break;
      if (await deleteUnlessLive(leaf, input.taskIsLive, input.legacyIsLive)) {
        removed.push(leaf.label);
        total -= leaf.bytes;
      }
    }
  }
  return removed;
}

async function deleteUnlessLive(
  leaf: CheckoutLeaf,
  taskIsLive: (taskId: string) => Promise<boolean>,
  legacyIsLive: ((checkout: LegacyCheckout) => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (leaf.taskId !== null && (await taskIsLive(leaf.taskId))) return false;
  if (leaf.taskId === null && leaf.legacy && legacyIsLive && (await legacyIsLive(leaf.legacy))) return false;
  return removeCheckout(leaf.full);
}

async function listCheckoutLeaves(root: string): Promise<CheckoutLeaf[]> {
  const leaves: CheckoutLeaf[] = [];
  const owners = await childDirectories(root);
  for (const owner of owners) {
    const repos = await childDirectories(path.join(root, owner));
    for (const repo of repos) {
      const names = await childDirectories(path.join(root, owner, repo));
      for (const name of names) {
        const full = path.join(root, owner, repo, name);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(full)).mtimeMs;
        } catch {
          continue;
        }
        const parsed = parseCheckoutName(name);
        leaves.push({
          label: `${owner}/${repo}/${name}`,
          full,
          mtimeMs,
          bytes: await directoryBytes(full),
          taskId: parsed?.taskId ?? null,
          legacy: parsed?.taskId === null && parsed.sha ? { owner, repo, sha: parsed.sha, full } : null,
        });
      }
    }
  }
  return leaves;
}

function parseCheckoutName(name: string): { sha: string; taskId: string | null } | null {
  const match = CHECKOUT_DIR.exec(name);
  if (!match?.[1]) return null;
  return { sha: match[1], taskId: match[2] ?? null };
}

async function directoryBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += (await stat(full)).size;
    } catch {
      continue;
    }
  }
  return total;
}

async function removeCheckout(full: string): Promise<boolean> {
  try {
    await rm(full, { recursive: true, force: true });
    return true;
  } catch {
    // The next sweep retries a directory that is busy.
    return false;
  }
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
  } catch (error) {
    if (isDiskFull(error)) throw error;
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
  } catch (error) {
    if (isDiskFull(error)) throw error;
    return false;
  }
}

function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "safe.directory=*", ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let killedForDisk = false;
    let settled = false;
    const stopChild = () => {
      // git-remote helpers inherit the pipes. Killing only the parent leaves `close` pending.
      const pid = child.pid;
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (error: Error | undefined, value = "") => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const capture = (into: "out" | "err", chunk: string) => {
      if (settled) return;
      if (into === "out") stdout += chunk;
      else stderr += chunk;
      if (!killedForDisk && into === "err" && diskFullGitError(stderr)) {
        killedForDisk = true;
        stopChild();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      capture("out", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      capture("err", chunk);
    });
    const onAbort = () => stopChild();
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      if (isDiskFull(error)) {
        finish(new Error("disk full"));
        return;
      }
      finish(error);
    });
    child.on("exit", (code) => {
      if (code === 0) return;
      if (killedForDisk || diskFullGitError(stderr)) {
        stopChild();
        finish(new Error("disk full"));
        return;
      }
      if (signal.aborted) {
        const reason = signal.reason;
        finish(reason instanceof Error ? reason : new Error("aborted"));
      }
    });
    child.on("close", (code) => {
      if (code !== 0 && (killedForDisk || diskFullGitError(stderr))) {
        finish(new Error("disk full"));
        return;
      }
      if (signal.aborted) {
        const reason = signal.reason;
        finish(reason instanceof Error ? reason : new Error("aborted"));
        return;
      }
      if (code === 0) {
        finish(undefined, stdout);
        return;
      }
      const command = args.filter((arg) => !arg.includes("AUTHORIZATION")).slice(0, 6).join(" ");
      finish(new Error(`git ${command} failed (${code}): ${stderr.slice(0, 400)}`));
    });
  });
}

function isDiskFull(error: unknown): boolean {
  if (error instanceof Error && error.message === "disk full") return true;
  return (error as NodeJS.ErrnoException).code === "ENOSPC";
}

function diskFullGitError(stderr: string): boolean {
  return stderr.split(/\r?\n/).some((line) => {
    const text = line.trim();
    if (!/^(fatal|error):/i.test(text)) return false;
    return text.includes("ENOSPC") || text.toLowerCase().includes("no space left on device");
  });
}
