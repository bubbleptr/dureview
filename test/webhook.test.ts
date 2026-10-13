import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGithubSignature } from "../src/github/signature.js";
import { parseWebhook } from "../src/github/webhook.js";
import { pullPayload, SHA_A } from "./support.js";

const SECRET = "It's a Secret to Everybody";
const BODY = "Hello, World!";
const KNOWN = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

describe("webhook signatures", () => {
  it("accepts the GitHub documented signature", () => {
    expect(verifyGithubSignature(BODY, KNOWN, SECRET)).toBe(true);
    expect(createHmac("sha256", SECRET).update(BODY).digest("hex")).toBe(KNOWN.slice("sha256=".length));
  });

  it("rejects a missing, tampered, or wrong-secret signature", () => {
    const raw = Buffer.from(JSON.stringify(pullPayload()));
    const good = `sha256=${createHmac("sha256", "secret").update(raw).digest("hex")}`;
    expect(verifyGithubSignature(raw, good, "secret")).toBe(true);
    expect(verifyGithubSignature(raw, undefined, "secret")).toBe(false);
    expect(verifyGithubSignature(raw, good, "other")).toBe(false);
    expect(verifyGithubSignature(Buffer.from(`${raw.toString("utf8")} `), good, "secret")).toBe(false);
    expect(verifyGithubSignature(raw, "sha256=abc", "secret")).toBe(false);
    expect(verifyGithubSignature(raw, good.slice(0, -1), "secret")).toBe(false);
  });
});

describe("webhook parsing", () => {
  it("queues opened, synchronize, reopened, and ready_for_review pull requests", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      const parsed = parseWebhook("pull_request", pullPayload(SHA_A, action));
      expect(parsed.kind).toBe("review");
      if (parsed.kind === "review") {
        expect(parsed.action).toBe(action);
        expect(parsed.request.sha).toBe(SHA_A);
        expect(parsed.request.baseRef).toBe("main");
        expect(parsed.request.owner).toBe("acme");
        expect(parsed.request.number).toBe(7);
        expect(parsed.request.installationId).toBe(99);
      }
    }
  });

  it("ignores other events and actions", () => {
    expect(parseWebhook("ping", {}).kind).toBe("ping");
    expect(parseWebhook("issues", pullPayload()).kind).toBe("ignore");
    expect(parseWebhook("pull_request", pullPayload(SHA_A, "closed")).kind).toBe("ignore");
    expect(parseWebhook("pull_request", { action: "opened" }).kind).toBe("ignore");
    expect(parseWebhook("issue_comment", { action: "edited" }).kind).toBe("ignore");
  });

  it("parses a /dureview comment on a pull request", () => {
    const parsed = parseWebhook("issue_comment", commentPayload("  /dureview  \nplease look again"));
    expect(parsed.kind).toBe("command");
    if (parsed.kind === "command") {
      expect(parsed.command).toMatchObject({ owner: "acme", repo: "demo", number: 7, commentId: 10, user: "alice" });
    }
    expect(parseWebhook("issue_comment", commentPayload("/dureview please")).kind).toBe("ignore");
    expect(parseWebhook("issue_comment", commentPayload("/dureview", "alice", { pullRequest: false })).kind).toBe("ignore");
    expect(parseWebhook("issue_comment", commentPayload("/dureview", "alice", { action: "edited" })).kind).toBe("ignore");
  });
});

function commentPayload(
  body: string,
  user = "alice",
  extra: { action?: string; pullRequest?: boolean; commentId?: number } = {},
): Record<string, unknown> {
  return {
    action: extra.action ?? "created",
    installation: { id: 99 },
    repository: {
      name: "demo",
      clone_url: "https://github.com/acme/demo.git",
      owner: { login: "acme" },
    },
    issue: {
      number: 7,
      ...(extra.pullRequest === false ? {} : { pull_request: { url: "https://api.github.com/repos/acme/demo/pulls/7" } }),
    },
    comment: {
      id: extra.commentId ?? 10,
      body,
      user: { login: user },
    },
  };
}
