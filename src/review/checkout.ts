import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitHub } from "../github/client.js";
import type { ReviewRequest } from "../types.js";
import { parseDureviewDocument, type PolicyDefaults, type ReviewPolicy, defaultPolicy } from "./policy.js";

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
