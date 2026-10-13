import { createHmac } from "node:crypto";
import { env, SELF, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const SECRET = "test-webhook-secret";

type ReviewCaller = {
  dispatch(event: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  armPause(): Promise<void>;
  releasePause(): Promise<void>;
  crashHarness(): Promise<void>;
  probeCrypto(): Promise<{ ok: boolean; error?: string }>;
  inspection(): Promise<Inspection>;
};

type Inspection = {
  postEntered: boolean;
  pausesRemaining: number;
  gitBase: string | null;
  clone: { ms: number; bytes: number; bytesTotal: number; head: string } | null;
  file: string | null;
  bytes: number;
  memory: { comments: string[]; reviews: number } | null;
  task: { status: string; error?: string } | null;
  toolText: string;
};

describe("cloudflare durable object", () => {
  it("answers health, rejects a bad signature, and routes each pull request to its own object", async () => {
    const health = await SELF.fetch("https://dureview.test/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const denied = await post(pullPayload(env.FIXTURE_SHA), "nope");
    expect(denied.status).toBe(401);

    const pull7 = env.REVIEW.idFromName("acme/demo#7").toString();
    const pull8 = env.REVIEW.idFromName("acme/demo#8").toString();
    expect(pull7).not.toBe(pull8);

    const probe = await caller("acme/demo#probe").probeCrypto();
    expect(probe.ok, probe.error).toBe(true);
  });

  it("clones, reviews, posts, and finishes the post after the object is evicted", async () => {
    const sha = env.FIXTURE_SHA;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const stub = caller("acme/demo#7");
    await stub.armPause();

    const opened = await post(pullPayload(sha));
    expect(opened.status).toBe(202);
    const body = (await opened.json()) as { taskId: number; deduped: boolean };
    expect(body.deduped).toBe(false);

    await waitFor(async () => (await stub.inspection()).postEntered, stub);

    const paused = await stub.inspection();
    expect(paused.memory?.comments ?? []).toEqual([]);
    expect(paused.pausesRemaining).toBe(1);
    expect(paused.file).toContain("if (amount > 0)");
    expect(paused.clone?.head).toBe(sha);
    expect(paused.gitBase).toBe(env.GIT_CLONE_BASE);

    await stub.crashHarness();
    await evictDurableObject(stub as never);
    await stub.releasePause();
    const ran = await runDurableObjectAlarm(stub as never);
    expect(ran).toBe(true);

    await waitFor(async () => ((await stub.inspection()).memory?.comments.length ?? 0) >= 1, stub);

    const done = await stub.inspection();
    expect(done.memory?.comments).toHaveLength(1);
    expect(done.memory?.reviews).toBe(1);
    expect(done.memory?.comments[0]).toContain("charge() reports success without billing.");
    expect(done.file).toContain("if (amount > 0)");
    expect(done.toolText).toContain("if (amount > 0)");
    expect(done.toolText).toContain("gateway.capture");
    expect(done.clone?.head).toBe(sha);
    expect(done.task?.status).toBe("completed");
    const stats = {
      cloneMs: done.clone?.ms,
      cloneBytes: done.clone?.bytes,
      bytesTotal: done.clone?.bytesTotal,
      sqliteBytes: done.bytes,
    };
    await fetch(`${env.GIT_CLONE_BASE}/__stats`, { method: "POST", body: JSON.stringify(stats) });
    expect(done.clone?.ms).toBeGreaterThan(0);
    expect(done.clone?.bytesTotal).toBeGreaterThan(0);
    expect(done.bytes).toBeGreaterThanOrEqual(done.clone?.bytesTotal ?? 0);
  });
});

function caller(name: string): ReviewCaller {
  const namespace = env.REVIEW as DurableObjectNamespace<ReviewCaller>;
  return namespace.get(namespace.idFromName(name));
}

function pullPayload(sha: string, number = 7): Record<string, unknown> {
  return {
    action: "opened",
    installation: { id: 99 },
    repository: {
      name: "demo",
      clone_url: "https://github.com/acme/demo.git",
      owner: { login: "acme" },
    },
    pull_request: {
      number,
      title: "Charge positive amounts",
      draft: false,
      head: { sha },
      base: { sha: "1111111111111111111111111111111111111111", ref: "main" },
    },
  };
}

function post(payload: Record<string, unknown>, secret = SECRET): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return SELF.fetch("https://dureview.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    body,
  });
}

async function waitFor(ready: () => Promise<boolean>, stub: ReviewCaller): Promise<void> {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 60_000) {
    if (await ready()) return;
    const view = await stub.inspection();
    last = JSON.stringify(view);
    if (view.task?.status === "failed") throw new Error(`review failed: ${view.task.error}\n${last}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for the review\n${last}`);
}
