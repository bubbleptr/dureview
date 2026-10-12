import type { ReviewRequest } from "../types.js";

const NAME = /^[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{7,64}$/i;

export type WebhookParse =
  | { kind: "ping" }
  | { kind: "ignore"; reason: string }
  | { kind: "review"; request: ReviewRequest };

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

/** Turn a verified `pull_request` delivery into a review request, or a reason to ignore it. */
export function parseWebhook(event: string | undefined, payload: unknown): WebhookParse {
  if (event === "ping") return { kind: "ping" };
  if (event !== "pull_request") return { kind: "ignore", reason: `event ${event ?? "missing"}` };
  if (!isRecord(payload)) return { kind: "ignore", reason: "payload is not an object" };

  const action = stringField(payload, "action");
  if (!action || !REVIEW_ACTIONS.has(action)) {
    return { kind: "ignore", reason: `action ${action ?? "missing"}` };
  }

  const repository = recordField(payload, "repository");
  const pull = recordField(payload, "pull_request");
  if (!repository || !pull) return { kind: "ignore", reason: "missing repository or pull_request" };

  const owner = repositoryOwner(repository);
  const repo = stringField(repository, "name");
  const number = pull.number;
  const title = stringField(pull, "title") ?? "";
  const draft = pull.draft === true;
  const head = recordField(pull, "head");
  const base = recordField(pull, "base");
  const sha = head ? stringField(head, "sha") : undefined;
  const baseSha = base ? stringField(base, "sha") : undefined;
  const cloneUrl = stringField(repository, "clone_url");
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) {
    return { kind: "ignore", reason: "invalid repository name" };
  }
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    return { kind: "ignore", reason: "invalid pull request number" };
  }
  if (!sha || !SHA.test(sha) || !baseSha || !SHA.test(baseSha)) {
    return { kind: "ignore", reason: "invalid commit sha" };
  }
  if (!cloneUrl || !isSafeHttpsUrl(cloneUrl)) {
    return { kind: "ignore", reason: "invalid clone url" };
  }

  const installation = recordField(payload, "installation");
  const installationId = installation && typeof installation.id === "number" ? installation.id : null;

  return {
    kind: "review",
    request: {
      owner,
      repo,
      number,
      sha,
      baseSha,
      title,
      cloneUrl,
      installationId,
      draft,
    },
  };
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
