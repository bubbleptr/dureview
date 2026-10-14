import type { GitHubRepo } from "../types.js";
import {
  checkoutCommitExists,
  checkoutDirectory,
  CHECKOUT_FILE_BYTES,
  readCheckoutFile,
  safeRepoPath,
  type CheckoutFile,
} from "../review/checkout.js";

export type ReviewFileContents =
  | { kind: "files"; oldText: string | null; newText: string | null }
  | { kind: "unavailable" };

type ContentsGitHub = {
  getRepoFile(request: GitHubRepo, path: string, ref: string, signal: AbortSignal): Promise<string | null>;
};

/**
 * Old (base) and new (head) text for one changed path.
 * A checkout that already contains both commits is read with `git show`.
 * Otherwise the GitHub contents API is tried at those SHAs.
 * A binary file, a file over 512 KiB, a bad path, or a failed lookup stays unavailable
 * so the diff can keep the hunk-only patch.
 */
export async function loadReviewFilePair(input: {
  checkoutRoot: string;
  github: ContentsGitHub;
  owner: string;
  repo: string;
  installationId: number | null;
  sha: string;
  baseSha: string;
  path: string;
  previousPath: string | null;
  signal: AbortSignal;
}): Promise<ReviewFileContents> {
  const newPath = input.path;
  const oldPath = input.previousPath && input.previousPath !== newPath ? input.previousPath : newPath;
  if (!safeRepoPath(newPath) || !safeRepoPath(oldPath)) return { kind: "unavailable" };

  const dir = checkoutDirectory(input.checkoutRoot, input.owner, input.repo, input.sha);
  const [headPresent, basePresent] = dir
    ? await Promise.all([
        checkoutCommitExists(dir, input.sha, input.signal),
        checkoutCommitExists(dir, input.baseSha, input.signal),
      ])
    : [false, false];
  if (dir && headPresent && basePresent) {
    try {
      const loaded = await readPair(dir, input.baseSha, oldPath, input.sha, newPath, input.signal);
      if (loaded) return loaded;
      return { kind: "unavailable" };
    } catch {
      // The checkout is there but unreadable. Try GitHub before giving up.
    }
  }

  try {
    const request = { owner: input.owner, repo: input.repo, installationId: input.installationId };
    const [newText, oldText] = await Promise.all([
      input.github.getRepoFile(request, newPath, input.sha, input.signal),
      input.github.getRepoFile(request, oldPath, input.baseSha, input.signal),
    ]);
    if (blockedText(newText) || blockedText(oldText)) return { kind: "unavailable" };
    if (newText === null && oldText === null) return { kind: "unavailable" };
    return { kind: "files", oldText, newText };
  } catch {
    return { kind: "unavailable" };
  }
}

async function readPair(
  dir: string,
  baseSha: string,
  oldPath: string,
  sha: string,
  newPath: string,
  signal: AbortSignal,
): Promise<ReviewFileContents | null> {
  const [oldFile, newFile] = await Promise.all([
    readCheckoutFile(dir, baseSha, oldPath, signal),
    readCheckoutFile(dir, sha, newPath, signal),
  ]);
  if (oldFile.kind === "blocked" || newFile.kind === "blocked") return null;
  const oldText = textOrNull(oldFile);
  const newText = textOrNull(newFile);
  if (oldText === null && newText === null) return null;
  return { kind: "files", oldText, newText };
}

function textOrNull(file: CheckoutFile): string | null {
  return file.kind === "text" ? file.text : null;
}

function blockedText(text: string | null): boolean {
  if (text === null) return false;
  if (text.includes("\0")) return true;
  return Buffer.byteLength(text) > CHECKOUT_FILE_BYTES;
}
