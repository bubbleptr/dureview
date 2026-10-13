import type { Workspace } from "@cloudflare/computer";
import type { GitHub } from "../../src/github/client.js";
import { readBaseDureview, type Checkout, type RepoCheckout } from "../../src/review/checkout.js";
import { truncateDiff } from "../../src/review/diff.js";
import type { PolicyDefaults } from "../../src/review/policy.js";
import type { ReviewRequest } from "../../src/types.js";

export const REPO_DIR = "/repo";

export type CloneStats = {
  ms: number;
  bytes: number;
  bytesTotal: number;
  head: string;
};

/**
 * Shallow-clone the pull request head into the workspace virtual filesystem.
 * Read-only after that: no exec, and the tools only read and grep.
 */
export class WorkspaceCheckout implements RepoCheckout {
  constructor(
    private readonly github: GitHub,
    private readonly workspace: Workspace,
    private readonly tokenFor: (request: ReviewRequest, signal: AbortSignal) => Promise<string | undefined>,
    private readonly policyDefaults: PolicyDefaults,
    private readonly cloneUrlFor: (request: ReviewRequest) => Promise<string>,
    private readonly bytes: () => number,
    private readonly observe: (stats: CloneStats) => Promise<void>,
  ) {}

  async prepare(request: ReviewRequest, signal: AbortSignal): Promise<Checkout> {
    const git = this.workspace.git;
    let head = await readHead(git);
    if (head !== request.sha) {
      await removeRepo(this.workspace);
      const before = this.bytes();
      const started = Date.now();
      const token = await this.tokenFor(request, signal);
      const url = await this.cloneUrlFor(request);
      if (signal.aborted) throw new Error("aborted");
      const headers = token ? { Authorization: `Basic ${btoa(`x-access-token:${token}`)}` } : undefined;
      // clone()'s ref is a branch name. A pull request head is refs/pull/N/head,
      // so init, fetch that ref, and detach HEAD at the webhook SHA.
      await git.init({ dir: REPO_DIR, defaultBranch: "main" });
      await git.remoteAdd({ dir: REPO_DIR, name: "origin", url });
      await git.fetch({
        dir: REPO_DIR,
        remote: "origin",
        remoteRef: `refs/pull/${request.number}/head`,
        depth: 1,
        singleBranch: true,
        ...(headers ? { headers } : {}),
      });
      await git.checkout({ dir: REPO_DIR, ref: request.sha, force: true });
      head = await readHead(git);
      if (head !== request.sha) {
        throw new Error(`Checked out ${request.owner}/${request.repo}#${request.number} but HEAD is not ${request.sha}.`);
      }
      const bytesTotal = this.bytes();
      await this.observe({
        ms: Date.now() - started,
        bytes: Math.max(0, bytesTotal - before),
        bytesTotal,
        head,
      });
    }
    const diffText = await this.github.getPullDiff(request, signal);
    const { diff, truncated } = truncateDiff(diffText);
    const loaded = await readBaseDureview(this.github, request, signal, this.policyDefaults);
    return { dir: REPO_DIR, diff, truncated, rules: loaded.rules, policy: loaded.policy };
  }
}

async function readHead(git: Workspace["git"]): Promise<string | undefined> {
  try {
    return (await git.revParse({ dir: REPO_DIR, ref: "HEAD" })).trim();
  } catch {
    return undefined;
  }
}

async function removeRepo(workspace: Workspace): Promise<void> {
  try {
    await workspace.fs.rm(REPO_DIR, { recursive: true, force: true });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return;
    throw error;
  }
}
