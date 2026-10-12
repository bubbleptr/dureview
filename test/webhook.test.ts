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
  it("queues opened, synchronize, and reopened pull requests", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      const parsed = parseWebhook("pull_request", pullPayload(SHA_A, action));
      expect(parsed.kind).toBe("review");
      if (parsed.kind === "review") {
        expect(parsed.request.sha).toBe(SHA_A);
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
  });
});
