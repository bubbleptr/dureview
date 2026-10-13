import type { ReviewTrigger } from "./policy.js";

/** Pull request actions that can start a review when `trigger` allows them. */
export const PULL_REVIEW_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"] as const;

export type PullReviewAction = (typeof PULL_REVIEW_ACTIONS)[number];

const REVIEW_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export type ReviewSkipReason = "draft" | "manual" | "once";

export type ReviewDecision = { review: true; once: boolean } | { review: false; reason: ReviewSkipReason };

/**
 * Decide whether a pull_request delivery should start a review.
 * `/dureview` does not go through this function.
 * `once` means the enqueue must also claim the one automatic review for the pull request.
 */
export function shouldReviewPull(input: {
  action: PullReviewAction;
  draft: boolean;
  trigger: ReviewTrigger;
  /** From `.dureview.md`. When false, drafts are skipped. */
  drafts: boolean;
  /** `DUREVIEW_SKIP_DRAFTS` forces a skip even when the file sets `drafts: true`. */
  forceSkipDrafts: boolean;
}): ReviewDecision {
  if (input.draft && (input.forceSkipDrafts || !input.drafts)) {
    return { review: false, reason: "draft" };
  }
  if (input.trigger === "manual") return { review: false, reason: "manual" };
  if (input.trigger === "once") {
    if (input.action !== "opened" && input.action !== "ready_for_review") {
      return { review: false, reason: "once" };
    }
    return { review: true, once: true };
  }
  return { review: true, once: false };
}

/** True when the first line of a comment is the review command. */
export function isReviewCommand(body: string): boolean {
  const first = body.split(/\r?\n/, 1)[0] ?? "";
  return first.trim() === "/dureview";
}

/** write, maintain, and admin may run `/dureview`. triage and read may not. */
export function permissionAllowsCommand(permission: string): boolean {
  return REVIEW_PERMISSIONS.has(permission);
}

/** Base branch names accepted from a webhook. Query-encoded before they are sent to GitHub. */
export function isBranchRef(value: string): boolean {
  if (value.length === 0 || value.length > 255) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.endsWith(".lock")) return false;
  if (value.includes("//") || value.includes("..") || value.includes("@{")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}
