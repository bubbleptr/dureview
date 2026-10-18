import type { ReviewRequest } from "../types.js";
import { isBranchRef, isReviewCommand, PULL_REVIEW_ACTIONS, type PullReviewAction } from "../review/trigger.js";

const NAME = /^[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{7,64}$/i;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?(?:\[bot\])?$/;
const REVIEW_ACTIONS = new Set<string>(PULL_REVIEW_ACTIONS);

export type ReviewCommand = {
  owner: string;
  repo: string;
  number: number;
  commentId: number;
  user: string;
  cloneUrl: string;
  installationId: number | null;
};

export type WebhookParse =
  | { kind: "ping" }
  | { kind: "ignore"; reason: string }
  | { kind: "review"; action: PullReviewAction; request: ReviewRequest }
  | { kind: "closed"; request: ReviewRequest; merged: boolean }
  | { kind: "command"; command: ReviewCommand };

/** Turn a verified delivery into a review, a `/dureview` command, or a reason to ignore it. */
export function parseWebhook(event: string | undefined, payload: unknown): WebhookParse {
  if (event === "ping") return { kind: "ping" };
  if (event === "issue_comment") return parseIssueComment(payload);
  if (event !== "pull_request") return { kind: "ignore", reason: `event ${event ?? "missing"}` };
  if (!isRecord(payload)) return { kind: "ignore", reason: "payload is not an object" };

  const action = stringField(payload, "action");
  if (action === "closed") return parseClosedPull(payload);
  if (!action || !REVIEW_ACTIONS.has(action)) {
    return { kind: "ignore", reason: `action ${action ?? "missing"}` };
  }

  const pull = parsePull(payload);
  if ("reason" in pull) return { kind: "ignore", reason: pull.reason };
  return { kind: "review", action: action as PullReviewAction, request: pull.request };
}

function parseClosedPull(payload: Record<string, unknown>): WebhookParse {
  const pull = parsePull(payload);
  if ("reason" in pull) return { kind: "ignore", reason: pull.reason };
  return { kind: "closed", request: pull.request, merged: pull.merged };
}

function parsePull(
  payload: Record<string, unknown>,
): { request: ReviewRequest; merged: boolean } | { reason: string } {
  const repository = recordField(payload, "repository");
  const pull = recordField(payload, "pull_request");
  if (!repository || !pull) return { reason: "missing repository or pull_request" };

  const parsed = parseRepository(payload, repository);
  if ("reason" in parsed) return { reason: parsed.reason };

  const number = pull.number;
  const title = stringField(pull, "title") ?? "";
  const draft = pull.draft === true;
  const head = recordField(pull, "head");
  const base = recordField(pull, "base");
  const sha = head ? stringField(head, "sha") : undefined;
  const baseSha = base ? stringField(base, "sha") : undefined;
  const baseRef = base ? stringField(base, "ref") : undefined;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    return { reason: "invalid pull request number" };
  }
  if (!sha || !SHA.test(sha) || !baseSha || !SHA.test(baseSha)) {
    return { reason: "invalid commit sha" };
  }
  if (!baseRef || !isBranchRef(baseRef)) return { reason: "invalid base ref" };

  return {
    merged: pull.merged === true,
    request: {
      ...parsed,
      number,
      sha,
      baseSha,
      baseRef,
      title,
      draft,
    },
  };
}

function parseIssueComment(payload: unknown): WebhookParse {
  if (!isRecord(payload)) return { kind: "ignore", reason: "payload is not an object" };
  const action = stringField(payload, "action");
  if (action !== "created") return { kind: "ignore", reason: `action ${action ?? "missing"}` };

  const issue = recordField(payload, "issue");
  const comment = recordField(payload, "comment");
  const repository = recordField(payload, "repository");
  if (!issue || !comment || !repository) return { kind: "ignore", reason: "missing issue, comment, or repository" };
  if (!recordField(issue, "pull_request")) return { kind: "ignore", reason: "not a pull request" };

  const body = typeof comment.body === "string" ? comment.body : "";
  if (!isReviewCommand(body)) return { kind: "ignore", reason: "not a command" };

  const parsed = parseRepository(payload, repository);
  if ("reason" in parsed) return { kind: "ignore", reason: parsed.reason };

  const number = issue.number;
  const commentId = comment.id;
  const userRecord = recordField(comment, "user");
  const user = userRecord ? stringField(userRecord, "login") : undefined;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    return { kind: "ignore", reason: "invalid pull request number" };
  }
  if (typeof commentId !== "number" || !Number.isSafeInteger(commentId) || commentId < 1) {
    return { kind: "ignore", reason: "invalid comment" };
  }
  if (!user || !LOGIN.test(user)) return { kind: "ignore", reason: "invalid comment" };

  return {
    kind: "command",
    command: { ...parsed, number, commentId, user },
  };
}

function parseRepository(
  payload: Record<string, unknown>,
  repository: Record<string, unknown>,
): { owner: string; repo: string; cloneUrl: string; installationId: number | null } | { reason: string } {
  const owner = repositoryOwner(repository);
  const repo = stringField(repository, "name");
  const cloneUrl = stringField(repository, "clone_url");
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return { reason: "invalid repository name" };
  if (!cloneUrl || !isSafeHttpsUrl(cloneUrl)) return { reason: "invalid clone url" };
  const installation = recordField(payload, "installation");
  const installationId = installation && typeof installation.id === "number" ? installation.id : null;
  return { owner, repo, cloneUrl, installationId };
}

function repositoryOwner(repository: Record<string, unknown>): string | undefined {
  const owner = recordField(repository, "owner");
  return owner ? stringField(owner, "login") : undefined;
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}
