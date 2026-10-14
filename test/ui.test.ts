import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewArchive } from "../src/review/archive.js";
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
    const stats = await fetch(`${http.url}/ui/stats`);
    const detail = await fetch(`${http.url}/ui/reviews/1`);
    const login = await fetch(`${http.url}/ui/login`, { method: "POST" });
    const settings = await fetch(`${http.url}/ui/settings`);
    expect(root.status).toBe(404);
    expect(login.status).toBe(404);
    expect(detail.status).toBe(404);
    expect(settings.status).toBe(404);
    expect(stats.status).toBe(404);
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
    expect(missing.headers.get("content-type")).toContain("text/html");
    expect(missing.headers.get("www-authenticate")).toBeNull();
    const loginHtml = await missing.text();
    expect(loginHtml).toContain('action="/ui/login"');
    expect(loginHtml).toContain("登录");
    expect(loginHtml).toContain('name="next" value="/ui"');
    expect(loginHtml).not.toContain(UI_TOKEN);
    expect(JSON.stringify(missing.headers)).not.toContain(UI_TOKEN);

    const wrong = await fetch(`${http.url}/ui`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });
    expect(wrong.headers.get("www-authenticate")).toContain("Basic");

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
    const page = await fetch(`${http.url}/ui/reviews`, { headers: { authorization: `Basic ${basic}` } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain(VERSION);
    expect(html).toContain("acme/demo #7");
    expect(html).toContain(`/ui/reviews/${body.taskId}`);
    expect(html).toContain("Charge positive amounts");
    expect(html).toContain(">auto<");
    expect(html).toContain("P0/P1");
    expect(html).toContain("access token expires ");
    expect(html).toContain('datetime="2030-01-02T03:04:05.000Z"');
    expect(html).toContain("2030-01-02 03:04 UTC");
    expect(html).toContain("GitHub App <b>no</b>");
    expect(html).toContain("GitHub token <b>yes</b>");
    expect(html).not.toContain("ACCESS_TOKEN_CANARY_9f3a");
    expect(html).not.toContain("REFRESH_TOKEN_CANARY_bb12");
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("test-token");
    expect(html).not.toContain(UI_TOKEN);
    expect(html).not.toContain(SHA_A);
    expect(html).not.toContain(dataDir);
    expect(html).not.toContain("billing");
    expect(html).not.toContain("never billed");
    expect(github.calls.filter((call) => call === "listPullFiles")).toHaveLength(0);

    github.pullFiles = [
      {
        filename: "src/pay.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        previousFilename: null,
        patch: [
          "@@ -1,5 +1,6 @@",
          " export function charge(amount: number): { ok: boolean } {",
          "-  return gateway.capture(amount);",
          "+  if (amount > 0) return { ok: true };",
          "+  return gateway.capture(amount);",
          " }",
          " ",
          " const gateway = {",
        ].join("\n"),
      },
    ];
    const detail = await fetch(`${http.url}/ui/reviews/${body.taskId}`, {
      headers: { authorization: `Bearer ${UI_TOKEN}` },
    });
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain("https://github.com/acme/demo/pull/7");
    expect(detailHtml).toContain("Reviews");
    expect(detailHtml).toContain("src/pay.ts");
    const detailText = detailHtml.replace(/<[^>]+>/g, "");
    const lineAt = detailText.indexOf("if (amount > 0) return { ok: true };");
    expect(lineAt).toBeGreaterThanOrEqual(0);
    expect(detailText.indexOf("never billed")).toBeGreaterThan(lineAt);
    expect(detailHtml).toContain(">trigger<");
    expect(detailHtml).toContain('title="manual"');
    expect(detailHtml).toContain("P1");
    expect(github.pullFileRequests).toEqual([{ installationId: 99, number: 7 }]);
    expect(detailHtml).not.toContain(SHA_A);
    expect(detailHtml).not.toContain(UI_TOKEN);
    const stored = await readFile(join(dataDir, "reviews.sqlite"));
    expect(stored.toString("utf8")).toContain("never billed");
    expect(stored.toString("utf8")).not.toContain("if (amount > 0) return { ok: true };");

    const ui = await fetch(`${http.url}/ui/`, { headers: { authorization: `Bearer ${UI_TOKEN}` } });
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("acme/demo");

    const posted = await fetch(`${http.url}/`, {
      method: "POST",
      headers: { authorization: `Bearer ${UI_TOKEN}` },
    });
    expect(posted.status).toBe(404);
  });

  it("stores a failed review's error in the archive but not the short log", async () => {
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
    const log = await readFile(join(dataDir, "reviews.json"), "utf8");
    expect(log).not.toContain("CANARY_SHOULD_NOT_BE_STORED");
    const stored = await readFile(join(dataDir, "reviews.sqlite"));
    expect(stored.toString("utf8")).toContain("CANARY_SHOULD_NOT_BE_STORED");
    expect(stored.toString("utf8")).toContain("Charge positive amounts");
    const archive = new ReviewArchive(join(dataDir, "reviews.sqlite"));
    await archive.open();
    const detail = await archive.get(String(queued.taskId));
    expect(detail?.error).toContain("clone failed CANARY_SHOULD_NOT_BE_STORED");
    archive.close();
  });

  it("sets an HttpOnly cookie from the login form and keeps bearer auth", async () => {
    const dataDir = await tempDataDir();
    const github = new MemoryGitHub();
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const http = await startHttp(service, { host: "127.0.0.1", port: 0, uiToken: UI_TOKEN, dataDir });
    closers.push(async () => {
      await http.close();
      await service.close();
    });

    const rejected = await fetch(`${http.url}/ui/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "wrong-token-canary", next: "/ui/reviews/1" }),
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("set-cookie")).toBeNull();
    expect(rejected.headers.get("www-authenticate")).toBeNull();
    const rejectedHtml = await rejected.text();
    expect(rejectedHtml).toContain("token 不正确");
    expect(rejectedHtml).not.toContain("wrong-token-canary");
    expect(rejectedHtml).not.toContain(UI_TOKEN);

    const evil = await fetch(`${http.url}/ui/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: UI_TOKEN, next: "https://evil.example/phish" }),
    });
    expect(evil.status).toBe(303);
    expect(evil.headers.get("location")).toBe("/ui");
    const setCookie = evil.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie.startsWith("dureview_ui=")).toBe(true);

    const cookie = setCookie.split(";")[0] ?? "";
    const page = await fetch(`${http.url}/ui`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("dureview");

    const detailNext = await fetch(`${http.url}/ui/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: UI_TOKEN, next: "/ui/reviews/task_1" }),
    });
    expect(detailNext.headers.get("location")).toBe("/ui/reviews/task_1");

    const fromRoot = await fetch(`${http.url}/ui/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: UI_TOKEN, next: "/" }),
    });
    expect(fromRoot.status).toBe(303);
    expect(fromRoot.headers.get("location")).toBe("/ui");
  });

  it("filters the list and hides unknown reviews", async () => {
    const dataDir = await tempDataDir();
    const archive = new ReviewArchive(join(dataDir, "reviews.sqlite"));
    await archive.open();
    await archive.start({
      taskId: "1",
      owner: "acme",
      repo: "demo",
      number: 7,
      title: "Charge positive amounts",
      sha: SHA_A,
      baseSha: "1111111111111111111111111111111111111111",
      baseRef: "main",
      installationId: 99,
      trigger: "opened",
    });
    await archive.finish({
      taskId: "1",
      owner: "acme",
      repo: "demo",
      number: 7,
      outcome: "completed",
      verdict: "fix_recommended",
      findingCount: 1,
      findings: [],
    });
    await archive.finish({
      taskId: "1",
      owner: "acme",
      repo: "demo",
      number: 7,
      outcome: "completed",
      verdict: "clean",
      findingCount: 0,
      findings: [],
    });
    await archive.start({
      taskId: "2",
      owner: "other",
      repo: "app",
      number: 3,
      title: "Rename helpers",
      sha: SHA_A,
      baseSha: "1111111111111111111111111111111111111111",
      baseRef: "main",
      installationId: 99,
      trigger: "command",
    });
    await archive.finish({
      taskId: "2",
      owner: "other",
      repo: "app",
      number: 3,
      outcome: "completed",
      verdict: "clean",
      findingCount: 0,
      findings: [],
    });
    archive.close();

    const github = new MemoryGitHub();
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const http = await startHttp(service, { host: "127.0.0.1", port: 0, uiToken: UI_TOKEN, dataDir });
    closers.push(async () => {
      await http.close();
      await service.close();
    });

    const filtered = await fetch(`${http.url}/ui/reviews?result=pass&repo=other/app&q=rename`, {
      headers: { authorization: `Bearer ${UI_TOKEN}` },
    });
    expect(filtered.status).toBe(200);
    const html = await filtered.text();
    expect(html).toContain("other/app #3");
    expect(html).toContain("/dureview");
    expect(html).toContain("Pass");
    expect(html).not.toContain("acme/demo #7");

    const missing = await fetch(`${http.url}/ui/reviews/missing`, {
      headers: { authorization: `Bearer ${UI_TOKEN}` },
    });
    expect(missing.status).toBe(404);
  });

  it("serves the statistics page behind the same token", async () => {
    const dataDir = await tempDataDir();
    const archive = new ReviewArchive(join(dataDir, "reviews.sqlite"));
    await archive.open();
    await archive.start({
      taskId: "1",
      owner: "acme",
      repo: "demo",
      number: 7,
      title: "Charge positive amounts",
      sha: SHA_A,
      baseSha: "1111111111111111111111111111111111111111",
      baseRef: "main",
      installationId: 99,
      trigger: "opened",
    });
    await archive.finish({
      taskId: "1",
      owner: "acme",
      repo: "demo",
      number: 7,
      outcome: "completed",
      verdict: "fix_recommended",
      findingCount: 1,
      provider: "faux",
      modelId: "faux-1",
      usage: {
        inputTokens: 400,
        outputTokens: 80,
        cacheReadTokens: 20,
        reasoningTokens: 0,
        modelCalls: 3,
        costUsd: 0,
      },
      findings: [
        {
          title: "Dropped charge",
          priority: 1,
          kind: "bug",
          category: "correctness",
          path: "src/pay.ts",
          startLine: 2,
          endLine: 2,
          body: "charge() reports success without billing.",
          trigger: "if (amount > 0) return { ok: true };",
          confidence: 0.9,
          fingerprint: "aaaaaaaaaaaa",
        },
      ],
    });
    archive.close();

    const github = new MemoryGitHub();
    const { service } = await openTestService({ dataDir, github, responses: [] });
    const http = await startHttp(service, { host: "127.0.0.1", port: 0, uiToken: UI_TOKEN, dataDir });
    closers.push(async () => {
      await http.close();
      await service.close();
    });

    const locked = await fetch(`${http.url}/ui/stats`, { redirect: "manual" });
    expect(locked.status).toBe(303);
    expect(locked.headers.get("location")).toBe("/ui");

    const page = await fetch(`${http.url}/ui/stats?range=all`, {
      headers: { authorization: `Bearer ${UI_TOKEN}` },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("Overview");
    expect(html).toContain("Tokens by day");
    expect(html).toContain("Avg tokens");
    expect(html).toContain("acme/demo");
    expect(html).toContain("Charge positive amounts");
    expect(html).not.toContain(UI_TOKEN);
    expect(html).not.toContain(SHA_A);
    expect(html).not.toContain('href="/ui/stats"');

    const list = await fetch(`${http.url}/ui`, { headers: { authorization: `Bearer ${UI_TOKEN}` } });
    expect(await list.text()).toContain('href="/ui/reviews"');

    const next = await fetch(`${http.url}/ui/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: UI_TOKEN, next: "/ui/stats" }),
    });
    expect(next.headers.get("location")).toBe("/ui");
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
