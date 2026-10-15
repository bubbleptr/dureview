import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { editableBaseline } from "../src/config.js";
import { settingsCsrfToken } from "../src/http/csrf.js";
import { ServerSettings } from "../src/settings/effective.js";
import { REVIEWS_DB_FILE } from "../src/review/archive.js";
import { startHttp } from "../src/server.js";
import { buildReviewDetail } from "../src/ui/detail-data.js";
import { buildReviewList } from "../src/ui/list-data.js";
import {
  MemoryGitHub,
  SECRET,
  SHA_A,
  SHA_B,
  openTestService,
  pullPayload as githubPull,
  reviewRequest,
  scriptedReview,
  tempDataDir,
} from "./support.js";

const UI_TOKEN = "ui-token-canary-not-in-page";
const TWO_MODELS = [
  { id: "faux-1", reasoning: true },
  { id: "faux-2", reasoning: true },
];

describe("settings precedence", () => {
  it("uses the built-in default, then the environment, then a UI override", async () => {
    const models = catalog();
    const file = join(await mkdtemp(join(tmpdir(), "dureview-settings-")), REVIEWS_DB_FILE);
    const settings = await ServerSettings.open({
      file,
      baseline: editableBaseline({}),
      models,
      provider: "openai-codex",
    });
    const initial = settings.effective();
    expect(initial).toMatchObject({
      modelId: "gpt-5.5",
      thinking: "medium",
      defaultTrigger: "manual",
      skipDrafts: false,
      checkoutTtlDays: 30,
    });
    const page = await settings.page();
    expect(page.fields.model.source).toBe("default");
    expect(page.fields.thinking.source).toBe("default");
    expect(page.fields.defaultTrigger.source).toBe("default");
    expect(page.modelOptions).toEqual(expect.arrayContaining(["gpt-5.5", "gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol"]));
    expect(page.thinkingByModel["gpt-5.5"]).not.toContain("max");
    expect(page.thinkingByModel["gpt-5.6-sol"]).toContain("max");
    expect(JSON.stringify(page)).not.toContain("sk-");
    expect(page.audit).toEqual([]);

    const unchanged = await settings.save(
      { model: "gpt-5.5", thinking: "medium", defaultTrigger: "manual", skipDrafts: false, checkoutTtlDays: "30" },
      "ui",
    );
    expect(unchanged).toEqual({ ok: true });
    expect((await settings.page()).fields.model.source).toBe("default");
    expect((await settings.page()).audit).toEqual([]);

    const env = await ServerSettings.open({
      file: join(await mkdtemp(join(tmpdir(), "dureview-settings-")), REVIEWS_DB_FILE),
      baseline: editableBaseline({
        DUREVIEW_MODEL: "gpt-5.5",
        DUREVIEW_THINKING: "low",
        DUREVIEW_DEFAULT_TRIGGER: "once",
        DUREVIEW_SKIP_DRAFTS: "1",
        DUREVIEW_CHECKOUT_TTL_DAYS: "14",
      }),
      models,
      provider: "openai-codex",
    });
    expect(env.effective()).toMatchObject({
      modelId: "gpt-5.5",
      thinking: "low",
      defaultTrigger: "once",
      skipDrafts: true,
      checkoutTtlDays: 14,
    });
    expect((await env.page()).fields.thinking).toMatchObject({ source: "env", value: "low", builtin: "medium" });

    const saved = await env.save(
      { model: "gpt-5.6-sol", thinking: "max", defaultTrigger: "auto", skipDrafts: false, checkoutTtlDays: "0" },
      "ui@203.0.113.9",
    );
    expect(saved).toEqual({ ok: true });
    expect(env.effective()).toMatchObject({
      modelId: "gpt-5.6-sol",
      thinking: "max",
      defaultTrigger: "auto",
      skipDrafts: false,
      checkoutTtlDays: 0,
    });
    const overridden = await env.page();
    expect(overridden.fields.model.source).toBe("override");
    expect(overridden.fields.thinking.source).toBe("override");
    expect(overridden.fields.skipDrafts).toMatchObject({ source: "override", value: "false", env: "true" });
    expect(overridden.audit[0]).toMatchObject({ actor: "ui@203.0.113.9", action: "set" });

    expect(await env.reset("checkoutTtlDays", "ui@203.0.113.9")).toEqual({ ok: true });
    expect(env.effective().checkoutTtlDays).toBe(14);
    expect(env.effective().modelId).toBe("gpt-5.6-sol");
    expect((await env.page()).fields.checkoutTtlDays.source).toBe("env");
    const blockedReset = await env.reset("model", "ui@203.0.113.9");
    expect(blockedReset.ok).toBe(false);

    const rejected = await env.save(
      { model: "gpt-5.5", thinking: "max", defaultTrigger: "auto", skipDrafts: false, checkoutTtlDays: "0" },
      "ui",
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toMatch(/not supported/);
    expect(env.effective().thinking).toBe("max");
    expect(env.effective().modelId).toBe("gpt-5.6-sol");

    expect(
      (
        await env.save(
          { model: "nope", thinking: "medium", defaultTrigger: "manual", skipDrafts: false, checkoutTtlDays: "1" },
          "ui",
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await env.save(
          { model: "gpt-5.5", thinking: "medium", defaultTrigger: "sometimes" as "manual", skipDrafts: false, checkoutTtlDays: "1" },
          "ui",
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await env.save(
          { model: "gpt-5.5", thinking: "medium", defaultTrigger: "manual", skipDrafts: false, checkoutTtlDays: "-3" },
          "ui",
        )
      ).ok,
    ).toBe(false);
    expect(env.effective().checkoutTtlDays).toBe(14);

    settings.close();
    env.close();
  });
});

describe("settings at runtime", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("applies trigger, draft skip, and checkout TTL to the next review without a restart", async () => {
    const github = new MemoryGitHub();
    const { service } = await openTestService({
      dataDir: await tempDataDir(),
      github,
      fauxModels: TWO_MODELS,
      thinking: "low",
      responses: scriptedReview("noted"),
    });
    closers.push(() => service.close());
    expect(service.effectiveConfig()).toMatchObject({ modelId: "faux-1", thinking: "low", defaultTrigger: "manual" });
    expect(service.checkoutTtlMs()).toBe(30 * 24 * 60 * 60 * 1000);

    const skipped = await deliver(service, pull(SHA_A));
    expect(skipped).toMatchObject({ status: 200, body: { ignored: true, reason: "manual" } });

    const saved = await service.saveSettings(
      { model: "faux-1", thinking: "low", defaultTrigger: "auto", skipDrafts: false, checkoutTtlDays: "3" },
      "tester",
    );
    expect(saved).toEqual({ ok: true });
    expect(service.checkoutTtlMs()).toBe(3 * 24 * 60 * 60 * 1000);
    const opened = await deliver(service, pull(SHA_A));
    expect(opened.status).toBe(202);

    github.files.set("main\0.dureview.md", "---\ntrigger: auto\ndrafts: true\n---\n");
    await service.saveSettings(
      { model: "faux-1", thinking: "low", defaultTrigger: "auto", skipDrafts: true, checkoutTtlDays: "3" },
      "tester",
    );
    const draft = await deliver(service, pull(SHA_B, "opened", true));
    expect(draft).toMatchObject({ status: 200, body: { ignored: true, reason: "draft" } });
  });

  it("keeps a running review on the model it started with", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enteredPost = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const github = new MemoryGitHub();
    const { service } = await openTestService({
      dataDir: await tempDataDir(),
      github,
      fauxModels: TWO_MODELS,
      thinking: "low",
      responses: [...scriptedReview("first finding"), ...scriptedReview("second finding")],
      hooks: {
        beforePost: async () => {
          entered();
          await gate;
        },
      },
    });
    closers.push(() => service.close());

    const first = await service.enqueue(reviewRequest(SHA_A), { kind: "sha" }, "opened");
    await enteredPost;
    const changed = await service.saveSettings(
      { model: "faux-2", thinking: "high", defaultTrigger: "manual", skipDrafts: false, checkoutTtlDays: "30" },
      "tester",
    );
    expect(changed).toEqual({ ok: true });
    expect(service.effectiveConfig()).toMatchObject({ modelId: "faux-2", thinking: "high" });
    release();
    const settled = await service.wait(first.taskId);
    expect(settled.state.outcome.status).toBe("completed");
    const finished = await service.reviewForUi(String(first.taskId), AbortSignal.timeout(5_000));
    expect(finished?.review.model).toBe("faux-1");
    expect(finished?.review.thinking).toBe("low");
    expect(finished?.review.provider).toBe("faux");
    const detail = buildReviewDetail({
      review: finished!.review,
      files: [],
      diffUnavailable: true,
      githubApiUrl: "https://api.github.com",
    });
    expect(detail.settings).toMatchObject({ recorded: true });
    if (detail.settings.recorded) {
      expect(detail.settings.rows).toEqual(expect.arrayContaining([{ key: "thinking", value: "low" }]));
    }

    const second = await service.enqueue(reviewRequest(SHA_B), { kind: "sha" }, "opened");
    const next = await service.wait(second.taskId);
    expect(next.state.outcome.status).toBe("completed");
    const later = await service.reviewForUi(String(second.taskId), AbortSignal.timeout(5_000));
    expect(later?.review.model).toBe("faux-2");
    expect(later?.review.thinking).toBe("high");
    const live = service.effectiveConfig();
    const listed = await buildReviewList(
      {
        service,
        provider: live.provider,
        modelId: live.modelId,
        thinking: live.thinking,
        githubApp: false,
        githubToken: false,
        startedAt: Date.now(),
      },
      new URLSearchParams(),
    );
    expect(listed.model).toBe("faux-2");
    expect(listed.thinking).toBe("high");
    expect(listed.reviews.map((row) => row.modelLine)).toEqual(["faux/faux-2 · high", "faux/faux-1 · low"]);
  });

  it("serves a token-protected settings page and rejects an unknown model", async () => {
    const dataDir = await tempDataDir();
    const github = new MemoryGitHub();
    const { service } = await openTestService({
      dataDir,
      github,
      fauxModels: TWO_MODELS,
      thinking: "low",
      responses: [],
    });
    const http = await startHttp(service, {
      host: "127.0.0.1",
      port: 0,
      uiToken: UI_TOKEN,
      dataDir,
      provider: "faux",
      modelId: "faux-1",
      githubToken: true,
    });
    closers.push(async () => {
      await http.close();
      await service.close();
    });

    const loggedOut = await fetch(`${http.url}/ui/settings`);
    expect(loggedOut.status).toBe(401);
    expect(await loggedOut.text()).toContain('name="next" value="/ui/settings"');

    const denied = await fetch(`${http.url}/ui/settings`, { headers: { authorization: "Bearer nope" } });
    expect(denied.status).toBe(401);

    const page = await fetch(`${http.url}/ui/settings`, { headers: { authorization: `Bearer ${UI_TOKEN}` } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Settings");
    expect(html).toContain("DUREVIEW_MODEL");
    expect(html).toContain("Environment");
    expect(html).toContain("faux-1");
    expect(html).toContain('data-ui="combobox"');
    expect(html).toContain(">low<");
    expect(html).toContain("faux/");
    expect(html).toContain(" · low");
    expect(html).not.toContain(UI_TOKEN);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("test-token");
    expect(html).not.toContain("WEBHOOK");

    const list = await fetch(`${http.url}/ui`, { headers: { authorization: `Bearer ${UI_TOKEN}` } });
    const listHtml = await list.text();
    expect(listHtml).toContain('href="/ui/settings"');
    expect(listHtml).not.toContain("faux/faux-1");

    const bad = await fetch(`${http.url}/ui/settings`, {
      method: "POST",
      headers: settingsHeaders(http.url),
      body: new URLSearchParams({
        model: "not-a-model",
        thinking: "low",
        defaultTrigger: "manual",
        checkoutTtlDays: "30",
        save: "1",
        csrf: settingsCsrfToken(UI_TOKEN),
      }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/Unknown model/);
    expect(service.effectiveConfig().modelId).toBe("faux-1");

    const ok = await fetch(`${http.url}/ui/settings`, {
      method: "POST",
      headers: { ...settingsHeaders(http.url), "x-forwarded-for": "203.0.113.4, 10.0.0.1" },
      body: new URLSearchParams({
        model: "faux-2",
        thinking: "high",
        defaultTrigger: "auto",
        skipDrafts: "true",
        checkoutTtlDays: "9",
        save: "1",
        csrf: settingsCsrfToken(UI_TOKEN),
      }),
      redirect: "manual",
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/ui/settings?saved=1");
    expect(service.effectiveConfig()).toMatchObject({
      modelId: "faux-2",
      thinking: "high",
      defaultTrigger: "auto",
      skipDrafts: true,
      checkoutTtlDays: 9,
    });

    const after = await fetch(`${http.url}/ui/settings?saved=1`, { headers: { authorization: `Bearer ${UI_TOKEN}` } });
    const afterHtml = await after.text();
    expect(afterHtml).toContain("Saved. New reviews use these settings.");
    expect(afterHtml).toContain("Override");
    expect(afterHtml).toContain("ui@203.0.113.4");
    expect(afterHtml).not.toContain(UI_TOKEN);

    const reset = await fetch(`${http.url}/ui/settings`, {
      method: "POST",
      headers: settingsHeaders(http.url),
      body: new URLSearchParams({ reset: "model", csrf: settingsCsrfToken(UI_TOKEN) }),
      redirect: "manual",
    });
    expect(reset.status).toBe(303);
    expect(service.effectiveConfig().modelId).toBe("faux-1");
    expect(service.effectiveConfig().thinking).toBe("high");

    const listed = await fetch(`${http.url}/ui/settings`, { headers: { authorization: `Bearer ${UI_TOKEN}` } });
    const listedHtml = await listed.text();
    expect(listedHtml).toContain("faux/");
    expect(listedHtml).toContain("faux-1");
    expect(listedHtml).toContain(" · high");
  });
});

function settingsHeaders(url: string): Record<string, string> {
  return {
    authorization: `Bearer ${UI_TOKEN}`,
    "content-type": "application/x-www-form-urlencoded",
    origin: new URL(url).origin,
    "sec-fetch-site": "same-origin",
  };
}

function catalog() {
  const models = createModels();
  models.setProvider(openaiCodexProvider());
  return models;
}

function deliver(service: { handleWebhook(raw: Buffer, signature: string | undefined, event: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> }, payload: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  return service.handleWebhook(raw, signature, "pull_request");
}

function pull(sha: string, action = "opened", draft = false): Record<string, unknown> {
  const payload = githubPull(sha, action);
  (payload.pull_request as { draft: boolean }).draft = draft;
  return payload;
}
