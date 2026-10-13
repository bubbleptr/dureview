import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoCheckout } from "../src/review/checkout.js";
import { startHttp } from "../src/server.js";
import { VERSION } from "../src/version.js";
import {
  MemoryGitHub,
  openTestService,
  pullPayload,
  scriptedReview,
  SECRET,
  SHA_A,
  tempDataDir,
} from "./support.js";

const UI_TOKEN = "ui-token-canary-not-in-page";

describe("status page", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("stays disabled when DUREVIEW_UI_TOKEN is unset", async () => {
    const github = new MemoryGitHub();
    const { service } = await openTestService({ dataDir: await tempDataDir(), github, responses: [] });
    const http = await startHttp(service, { host: "127.0.0.1", port: 0 });
    closers.push(async () => {
      await http.close();
      await service.close();
    });

    const root = await fetch(`${http.url}/`);
    const ui = await fetch(`${http.url}/ui`);
    expect(root.status).toBe(404);
    expect(await root.json()).toEqual({ error: "not found" });
    expect(root.headers.get("www-authenticate")).toBeNull();
    expect(ui.status).toBe(404);
    expect((await fetch(`${http.url}/health`)).status).toBe(200);
  });

  it("renders recent reviews for a valid token and still verifies webhooks", async () => {
    const dataDir = await tempDataDir();
    const github = new MemoryGitHub();
    github.files.set("main\0.dureview.md", "---\ntrigger: auto\n---\n");
    const { service } = await openTestService({
      dataDir,
      github,
      responses: scriptedReview("charge() reports success without billing."),
    });
    const http = await startHttp(service, {
      host: "127.0.0.1",
      port: 0,
      uiToken: UI_TOKEN,
      dataDir,
      githubApp: false,
      githubToken: true,
      githubApiUrl: "https://api.github.com",
      provider: "faux",
      modelId: "faux-1",
      startedAt: Date.now() - 65_000,
    });
    closers.push(async () => {
      await http.close();
      await service.close();
    });

    await writeFile(
      join(dataDir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "ACCESS_TOKEN_CANARY_9f3a",
          refresh: "REFRESH_TOKEN_CANARY_bb12",
          expires: Date.parse("2030-01-02T03:04:05.000Z"),
        },
      }),
      { mode: 0o600 },
    );

    const health = await fetch(`${http.url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect(health.headers.get("www-authenticate")).toBeNull();

    const missing = await fetch(`${http.url}/`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "unauthorized" });
    expect(missing.headers.get("www-authenticate")).toContain("Basic");
    expect(JSON.stringify(missing.headers)).not.toContain(UI_TOKEN);

    const wrong = await fetch(`${http.url}/ui`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);

    const query = await fetch(`${http.url}/?token=${UI_TOKEN}`);
    expect(query.status).toBe(401);
    expect(await query.text()).not.toContain(UI_TOKEN);

    const denied = await post(http.url, pullPayload(SHA_A), "nope");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "invalid signature" });
    expect(denied.headers.get("www-authenticate")).toBeNull();

    const opened = await post(http.url, pullPayload(SHA_A), SECRET);
    expect(opened.status).toBe(202);
    const body = (await opened.json()) as { taskId: number; deduped: boolean };
    expect(body.deduped).toBe(false);
    const settled = await service.wait(body.taskId as never);
    expect(settled.state.outcome.status).toBe("completed");

    const basic = Buffer.from(`dureview:${UI_TOKEN}`).toString("base64");
    const page = await fetch(`${http.url}/`, { headers: { authorization: `Basic ${basic}` } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain(VERSION);
    expect(html).toContain("acme/demo");
    expect(html).toContain("https://github.com/acme/demo/pull/7");
    expect(html).toContain("opened");
    expect(html).toContain("fix recommended · 1 finding");
    expect(html).toContain("access token expires 2030-01-02 03:04 UTC");
    expect(html).toContain("<dt>GitHub App</dt><dd>no</dd>");
    expect(html).toContain("<dt>GitHub token</dt><dd>yes</dd>");
    expect(html).not.toContain("ACCESS_TOKEN_CANARY_9f3a");
    expect(html).not.toContain("REFRESH_TOKEN_CANARY_bb12");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("test-token");
    expect(html).not.toContain(UI_TOKEN);
    expect(html).not.toContain(SHA_A);
    expect(html).not.toContain(dataDir);
    expect(html).not.toContain("Charge positive amounts");
    expect(html).not.toContain("billing");

    const ui = await fetch(`${http.url}/ui/`, { headers: { authorization: `Bearer ${UI_TOKEN}` } });
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("acme/demo");

    const posted = await fetch(`${http.url}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${UI_TOKEN}` },
    });
    expect(posted.status).toBe(404);
  });

  it("records a failed review without the failure text", async () => {
    const dataDir = await tempDataDir();
    const github = new MemoryGitHub();
    const checkout: RepoCheckout = {
      async prepare() {
        throw new Error("clone failed CANARY_SHOULD_NOT_BE_STORED");
      },
    };
    const { service } = await openTestService({ dataDir, github, checkout, responses: [] });
    closers.push(() => service.close());
    const queued = await service.enqueue(
      {
        owner: "acme",
        repo: "demo",
        number: 7,
        sha: SHA_A,
        baseSha: "1111111111111111111111111111111111111111",
        baseRef: "main",
        title: "Charge positive amounts",
        cloneUrl: "https://github.com/acme/demo.git",
        installationId: 99,
        draft: false,
      },
      { kind: "sha" },
      "opened",
    );
    const settled = await service.wait(queued.taskId);
    expect(settled.state.outcome.status).toBe("failed");
    const reviews = await service.recentReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      owner: "acme",
      repo: "demo",
      number: 7,
      trigger: "opened",
      outcome: "failed",
      verdict: null,
      findingCount: null,
    });
    expect(JSON.stringify(reviews)).not.toContain("CANARY_SHOULD_NOT_BE_STORED");
  });
});

function post(url: string, payload: Record<string, unknown>, secret: string): Promise<Response> {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return fetch(`${url}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    body: raw,
  });
}
