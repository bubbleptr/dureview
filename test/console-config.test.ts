import { createServer, type Server } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { PROVIDER_IDS } from "../src/auth/providers.js";
import { LoginSessions } from "../src/auth/device-login.js";
import { publicAuthError, subscriptionView } from "../src/auth/reveal.js";
import { FileCredentialStore } from "../src/auth/store.js";
import { assertServeConfig, configFromEnv, editableBaseline } from "../src/config.js";
import { activeGitHub, activeWebhookSecret, githubSetupView } from "../src/github/access.js";
import { GitHubAppFile, parseStoredGitHubApp } from "../src/github/app-file.js";
import { exchangeAppManifest, manifestCreateUrl, manifestHandoffPage } from "../src/github/manifest.js";
import { postIsSameOrigin, settingsCsrfToken } from "../src/http/csrf.js";
import { REVIEWS_DB_FILE } from "../src/review/archive.js";
import { ServerSettings } from "../src/settings/effective.js";
import { startHttp } from "../src/server.js";
import { MemoryGitHub, openTestService, tempDataDir } from "./support.js";

const UI_TOKEN = "ui-token-canary-not-in-page";
const KEY = "sk-live-CANARYPREFIX-9f3a";
const PEM = "-----BEGIN PRIVATE KEY-----\nSAVEDKEYMATERIALCANARY\n-----END PRIVATE KEY-----\n";

const reviewDefaults = {
  defaultTrigger: "manual" as const,
  skipDrafts: false,
  checkoutTtlDays: "30",
};

describe("provider config", () => {
  it("accepts the six providers and rejects a Claude subscription id", () => {
    for (const id of PROVIDER_IDS) {
      expect(configFromEnv({ DUREVIEW_PROVIDER: id }).provider).toBe(id);
    }
    expect(() => configFromEnv({ DUREVIEW_PROVIDER: "anthropic" })).toThrow(/anthropic/);
    expect(() => assertServeConfig(configFromEnv({}))).not.toThrow();
    expect(() => assertServeConfig(configFromEnv({ GITHUB_APP_ID: "12" }))).toThrow(/private key/);
    expect(() => assertServeConfig(configFromEnv({ GITHUB_APP_PRIVATE_KEY: "not-a-path" }))).toThrow(/GITHUB_APP_ID/);
  });

  it("lets an override beat the env provider, which beats the fallback", async () => {
    const models = createModels();
    models.setProvider(openaiCodexProvider());
    models.setProvider(openaiProvider());
    models.setProvider(deepseekProvider());
    const settings = await ServerSettings.open({
      file: join(await mkdtemp(join(tmpdir(), "dureview-console-")), REVIEWS_DB_FILE),
      baseline: editableBaseline({ DUREVIEW_PROVIDER: "openai" }),
      models,
      provider: "openai-codex",
    });
    expect(settings.effective().provider).toBe("openai");
    const initial = await settings.page();
    expect(initial.modelOptions).toContain("gpt-5.5");
    expect(initial.modelOptions).not.toContain("deepseek-v4-pro");
    expect(initial.catalogs.find((catalog) => catalog.provider === "deepseek")?.models.length).toBeGreaterThan(0);

    const kept = await settings.save(
      { provider: "", model: "gpt-5.5", thinking: "medium", ...reviewDefaults },
      "ui",
    );
    expect(kept).toEqual({ ok: true });
    expect(settings.effective().provider).toBe("openai");

    const saved = await settings.save(
      { provider: "deepseek", model: "deepseek-v4-pro", thinking: "high", ...reviewDefaults },
      "ui",
    );
    expect(saved).toEqual({ ok: true });
    expect(settings.effective()).toMatchObject({ provider: "deepseek", modelId: "deepseek-v4-pro", thinking: "high" });
    const page = await settings.page();
    expect(page.fields.provider.source).toBe("override");
    expect(page.modelOptions).toContain("deepseek-v4-pro");
    expect(page.modelOptions).not.toContain("gpt-5.5");
    expect(page.thinkingByModel["deepseek-v4-pro"]).not.toContain("medium");

    const blocked = await settings.reset("provider", "ui");
    expect(blocked.ok).toBe(false);
    expect(settings.effective().provider).toBe("deepseek");
    settings.close();
  });
});

describe("stored credentials", () => {
  const closers: Array<() => Promise<void>> = [];
  const previousOpenAi = process.env.OPENAI_API_KEY;
  afterEach(async () => {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    while (closers.length > 0) await closers.pop()?.();
  });

  it("stores an API key as configured plus the last four characters", async () => {
    const dataDir = await tempDataDir();
    const { service } = await openTestService({ dataDir, github: new MemoryGitHub(), responses: [] });
    closers.push(() => service.close());
    const store = new FileCredentialStore(join(dataDir, "auth.json"));
    await store.modify("openai", async () => ({
      type: "oauth",
      access: "ACCESS-CANARY-SHOULD-NOT-LEAK",
      refresh: "REFRESH-CANARY-SHOULD-NOT-LEAK",
      expires: Date.now() + 60_000,
    }));
    expect((await service.saveApiKey("openai", KEY)).ok).toBe(false);

    await store.delete("openai");
    expect(await service.saveApiKey("openai", KEY)).toEqual({ ok: true });
    expect(await service.saveApiKey("openai", "short")).toMatchObject({ ok: false });
    const page = await service.settingsPage();
    const openai = page.console.apiKeys.find((row) => row.provider === "openai");
    expect(openai).toMatchObject({ stored: true, tail: "9f3a", fromEnv: false });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("CANARYPREFIX");
    expect(serialized).not.toContain("ACCESS-CANARY");
    expect(serialized).toContain("9f3a");
    expect((await stat(join(dataDir, "auth.json"))).mode & 0o777).toBe(0o600);

    process.env.OPENAI_API_KEY = "env-canary-key-ZZZZ-not-shown";
    await service.clearApiKey("openai");
    const cleared = await service.settingsPage();
    expect(cleared.console.apiKeys.find((row) => row.provider === "openai")).toMatchObject({
      stored: false,
      tail: null,
      fromEnv: true,
    });
    expect(JSON.stringify(cleared)).not.toContain("env-canary-key");
    expect(JSON.stringify(cleared)).not.toContain("ZZZZ");
  });
});

describe("GitHub App file", () => {
  const stored = {
    appId: "42",
    privateKey: PEM,
    webhookSecret: "webhook-secret-canary-9999",
    slug: "dureview-app",
    name: "dureview",
    htmlUrl: "https://github.com/apps/dureview-app",
  };

  it("prefers an env app, then a token, then the saved app", async () => {
    const file = join(await tempDataDir(), "github-app.json");
    const apps = await GitHubAppFile.open(file);
    await apps.save(stored);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(file, ".."))).mode & 0o777).toBe(0o700);

    const none = { githubAppId: undefined, githubAppPrivateKey: undefined, githubToken: undefined };
    expect(activeGitHub({ ...none, githubAppId: "7", githubAppPrivateKey: "env-pem", githubToken: "tok" }, stored)).toMatchObject({
      kind: "app",
      source: "environment",
      appId: "7",
    });
    expect(activeGitHub({ ...none, githubToken: "tok" }, stored)).toMatchObject({ kind: "token" });
    expect(activeGitHub(none, stored)).toMatchObject({ kind: "app", source: "saved", appId: "42" });
    expect(activeWebhookSecret({ webhookSecret: "env-secret" }, stored).source).toBe("environment");
    expect(activeWebhookSecret({ webhookSecret: undefined }, stored)).toMatchObject({ source: "saved" });

    const view = githubSetupView({
      config: { ...none, webhookSecret: undefined },
      stored,
      unreadable: false,
      probe: { slug: "dureview-app", accounts: ["acme"], error: null },
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain("PRIVATE KEY");
    expect(json).not.toContain("SAVEDKEY");
    expect(json).not.toContain("webhook-secret-canary");
    expect(view).toMatchObject({
      kind: "saved",
      appId: "42",
      webhookTail: "9999",
      installUrl: "https://github.com/apps/dureview-app/installations/new",
      installations: ["acme"],
    });
    const enterprise = githubSetupView({
      config: { ...none, webhookSecret: undefined, githubApiUrl: "https://ghe.example.com/api/v3" },
      stored,
      unreadable: false,
      probe: { slug: "dureview-app", accounts: ["acme"], error: null },
    });
    expect(enterprise.installUrl).toBe("https://ghe.example.com/apps/dureview-app/installations/new");
  });

  it("exchanges a manifest code and drops the client secret", async () => {
    expect(manifestCreateUrl("https://api.github.com", "")).toBe("https://github.com/settings/apps/new");
    expect(manifestCreateUrl("https://api.github.com", "acme")).toBe("https://github.com/organizations/acme/settings/apps/new");
    expect(manifestCreateUrl("https://ghe.example.com/api/v3", "")).toBe("https://ghe.example.com/settings/apps/new");
    expect(manifestCreateUrl("https://ghe.example.com/api/v3", "acme")).toBe(
      "https://ghe.example.com/organizations/acme/settings/apps/new",
    );
    expect(manifestCreateUrl("javascript:alert(1)", "")).toBeNull();
    const html = manifestHandoffPage("https://github.com/settings/apps/new", {
      name: "dureview",
      url: "https://review.example/ui",
      description: "Adversarial pull request review",
      public: false,
      redirect_url: "https://review.example/ui/settings?setup=github&state=abc",
      setup_url: "https://review.example/ui/settings",
      hook_attributes: { url: "https://review.example/webhook", active: true },
      default_permissions: { contents: "read", issues: "write", pull_requests: "write", checks: "write" },
      default_events: ["pull_request", "issue_comment"],
      request_oauth_on_install: false,
    });
    expect(html).toContain("https://github.com/settings/apps/new");
    expect(html).toContain("pull_request");
    const app = await exchangeAppManifest({
      code: "abc12345",
      apiUrl: "https://api.github.com",
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://api.github.com/app-manifests/abc12345/conversions");
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            id: 99,
            pem: PEM,
            webhook_secret: "whsec-canary-abcd",
            slug: "dureview",
            name: "dureview",
            html_url: "https://github.com/apps/dureview",
            client_secret: "CLIENT-SECRET-CANARY",
          }),
        );
      },
    });
    expect(app.appId).toBe("99");
    expect(app.privateKey).toContain("PRIVATE KEY");
    expect(JSON.stringify(app)).not.toContain("CLIENT-SECRET");
  });

  it("keeps the file and the in-memory app aligned when saves overlap", async () => {
    const file = join(await tempDataDir(), "github-app.json");
    const apps = await GitHubAppFile.open(file);
    const first = { ...stored, appId: "11", name: "first" };
    const second = { ...stored, appId: "22", name: "second" };
    await Promise.all([apps.save(first), apps.save(second)]);
    const text = await readFile(file, "utf8");
    const onDisk = parseStoredGitHubApp(JSON.parse(text));
    expect(onDisk).toEqual(second);
    expect(apps.current()).toEqual(second);
    const reloaded = await GitHubAppFile.open(file);
    expect(reloaded.current()).toEqual(second);
    const names = await readdir(dirname(file));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("GitHub setup exchange", () => {
  it("holds the pending setup until the manifest exchange finishes", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const code = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url ?? "")?.[1];
      if (req.method !== "POST" || !code) {
        res.writeHead(404).end();
        return;
      }
      seen.push(code);
      void gate.then(() => {
        const first = code === "firstcode";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(manifestPayload(first ? 11 : 22, first ? "first" : "second"));
      });
    });
    const port = await listen(server);
    try {
      const dataDir = await tempDataDir();
      const { service } = await openTestService({
        dataDir,
        github: new MemoryGitHub(),
        responses: [],
        githubApiUrl: `http://127.0.0.1:${port}`,
      });
      try {
        const handoff = service.beginGitHubSetup("http://127.0.0.1", "");
        const state = setupState(handoff);
        const mismatch = await service.finishGitHubSetup("0".repeat(64), "firstcode");
        expect(mismatch).toEqual({ ok: false, error: "GitHub setup expired. Start it again from settings." });

        const finishing = service.finishGitHubSetup(state, "firstcode");
        const again = service.beginGitHubSetup("http://127.0.0.1", "");
        expect(again?.status).toBe(303);
        expect(again?.headers.get("location")).toContain("already%20finishing");
        const second = await service.finishGitHubSetup(state, "secondcode");
        expect(second).toEqual({ ok: false, error: "GitHub setup is already finishing. Start it again from settings." });

        release();
        expect(await finishing).toEqual({ ok: true });
        expect(seen).toEqual(["firstcode"]);
        const saved = await GitHubAppFile.open(join(dataDir, "github-app.json"));
        expect(saved.current()).toMatchObject({ appId: "11", name: "first" });

        const restarted = service.beginGitHubSetup("http://127.0.0.1", "");
        expect(restarted?.status).toBe(200);
        expect(setupState(restarted)).not.toBe(state);
      } finally {
        release();
        await service.close();
      }
    } finally {
      await closeServer(server);
    }
  });

  it("releases the setup lock when the manifest body never finishes", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"id":');
    });
    const port = await listen(server);
    try {
      const dataDir = await tempDataDir();
      const { service } = await openTestService({
        dataDir,
        github: new MemoryGitHub(),
        responses: [],
        githubApiUrl: `http://127.0.0.1:${port}`,
      });
      try {
        const state = setupState(service.beginGitHubSetup("http://127.0.0.1", ""));
        const started = Date.now();
        const failed = await service.finishGitHubSetup(state, "firstcode", AbortSignal.timeout(200));
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(failed.ok).toBe(false);
        const restarted = service.beginGitHubSetup("http://127.0.0.1", "");
        expect(restarted?.status).toBe(200);
        expect(setupState(restarted)).not.toBe(state);
      } finally {
        await service.close();
      }
    } finally {
      server.closeAllConnections();
      await closeServer(server);
    }
  });

  it("clears a failed exchange so setup can start again", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(422).end("nope");
    });
    const port = await listen(server);
    try {
      const dataDir = await tempDataDir();
      const { service } = await openTestService({
        dataDir,
        github: new MemoryGitHub(),
        responses: [],
        githubApiUrl: `http://127.0.0.1:${port}`,
      });
      try {
        const state = setupState(service.beginGitHubSetup("http://127.0.0.1", ""));
        const failed = await service.finishGitHubSetup(state, "firstcode");
        expect(failed.ok).toBe(false);
        const restarted = service.beginGitHubSetup("http://127.0.0.1", "");
        expect(restarted?.status).toBe(200);
        expect(setupState(restarted)).not.toBe(state);
      } finally {
        await service.close();
      }
    } finally {
      await closeServer(server);
    }
  });
});

function manifestPayload(id: number, name: string): string {
  return JSON.stringify({
    id,
    pem: PEM,
    webhook_secret: "whsec-canary-abcd",
    slug: "dureview",
    name,
    html_url: "https://github.com/apps/dureview",
  });
}

function setupState(response: Response | null): string {
  const state = /dureview_github_setup=([a-f0-9]{64})/.exec(response?.headers.get("set-cookie") ?? "")?.[1];
  if (!state) throw new Error("missing GitHub setup state");
  return state;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server has no port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("device-code login", () => {
  it("forces the device-code choice and shows only the code", async () => {
    let seen = "";
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sessions = new LoginSessions(async (_provider, interaction) => {
      seen = await interaction.prompt(selectPrompt());
      const enterprise = await interaction.prompt({ type: "text", message: "Enterprise domain" });
      expect(enterprise).toBe("ghe.example.com");
      interaction.notify({
        type: "device_code",
        verificationUri: "https://auth.example/device",
        userCode: "WXYZ-9999",
        expiresInSeconds: 60,
      });
      await hold;
      return { access: "ACCESS-CANARY-TOKEN-VALUE" };
    });
    expect(sessions.start("github-copilot", "  ghe.example.com  ")).toEqual({ ok: true });
    await sessions.waitForCode("github-copilot", 1000);
    expect(seen).toBe("device_code");
    const snap = JSON.stringify(sessions.snapshot());
    expect(snap).toContain("https://auth.example/device");
    expect(snap).toContain("WXYZ-9999");
    expect(snap).not.toContain("ACCESS-CANARY");
    release();
  });

  it("aborts the previous attempt and rejects a localhost callback", async () => {
    let aborted = false;
    const sessions = new LoginSessions(async (_provider, interaction) => {
      interaction.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      interaction.notify({
        type: "device_code",
        verificationUri: "https://auth.example/device",
        userCode: "WXYZ-9999",
      });
      await new Promise((_resolve, reject) => {
        interaction.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    sessions.start("xai", "");
    await sessions.waitForCode("xai", 1000);
    sessions.start("openai-codex", "");
    expect(aborted).toBe(false);
    sessions.start("xai", "");
    await Promise.resolve();
    expect(aborted).toBe(true);

    const callback = new LoginSessions(async (_provider, interaction) => {
      interaction.notify({ type: "auth_url", url: "http://127.0.0.1:9/callback?token=ACCESS-CANARY" });
      throw new Error("Bearer ACCESS-CANARY-TOKEN-VALUE should not be shown");
    });
    callback.start("openai-codex", "");
    await callback.waitForCode("openai-codex", 1000);
    const view = callback.snapshot()[0];
    expect(view?.phase).toBe("error");
    expect(view?.message).toBe("This server only completes device-code login.");
    expect(JSON.stringify(callback.snapshot())).not.toContain("ACCESS-CANARY");
    expect(JSON.stringify(callback.snapshot())).not.toContain("127.0.0.1");
  });

  it("labels a subscription from the token email and hides the tokens", () => {
    const payload = Buffer.from(JSON.stringify({ email: "ops@example.com" })).toString("base64url");
    const access = `eyJhbGciOiJub25lIn0.${payload}.signature`;
    const view = subscriptionView(
      "openai-codex",
      { type: "oauth", access, refresh: "REFRESH-CANARY-SHOULD-NOT-LEAK", expires: Date.parse("2030-01-02T03:04:05.000Z") },
      false,
    );
    expect(view).toMatchObject({ present: true, account: "ops@example.com", expiresAt: "2030-01-02T03:04:05.000Z" });
    expect(JSON.stringify(view)).not.toContain("REFRESH-CANARY");
    expect(JSON.stringify(view)).not.toContain(access);
    expect(publicAuthError(new Error(`Bearer ${"A".repeat(40)}`))).not.toContain("AAAA");
  });
});

describe("settings console HTTP", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("requires the console token and does not echo a saved key", async () => {
    const dataDir = await tempDataDir();
    const { service } = await openTestService({ dataDir, github: new MemoryGitHub(), responses: [] });
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
    const auth = { authorization: `Bearer ${UI_TOKEN}` };

    const poll = await fetch(`${http.url}/ui/settings?poll=1`);
    expect(poll.status).toBe(401);
    const denied = await fetch(`${http.url}/ui/settings`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ action: "api-key", provider: "openai", key: KEY }),
    });
    expect(denied.status).toBe(401);

    const saved = await settingsPost(http.url, UI_TOKEN, { action: "api-key", provider: "openai", key: KEY });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/ui/settings?key=saved");

    const page = await fetch(`${http.url}/ui/settings?key=saved`, { headers: auth });
    const html = await page.text();
    expect(html).toContain("API key saved. The full key is not shown again.");
    expect(html).toContain("9f3a");
    expect(html).not.toContain("CANARYPREFIX");
    expect(html).not.toContain(UI_TOKEN);
    expect(html).not.toContain(KEY);
    expect(html).toContain(`name="csrf" value="${settingsCsrfToken(UI_TOKEN)}"`);

    const live = await fetch(`${http.url}/ui/settings?poll=1`, { headers: auth });
    expect(live.status).toBe(200);
    const body = await live.text();
    expect(body).not.toContain("CANARYPREFIX");
    expect(body).not.toContain("9f3a");

    const handoff = await settingsPost(http.url, UI_TOKEN, { action: "github-manifest", org: "" });
    expect(handoff.status).toBe(200);
    expect(handoff.headers.get("content-security-policy")).toContain("form-action https://github.com");
    const handoffHtml = await handoff.text();
    expect(handoffHtml).toContain("https://github.com/settings/apps/new");
    expect(handoffHtml).not.toContain("PRIVATE KEY");
    const state = /dureview_github_setup=([a-f0-9]{64})/.exec(handoff.headers.get("set-cookie") ?? "")?.[1];
    expect(state).toBeTruthy();
    const mismatch = await fetch(`${http.url}/ui/settings?setup=github&state=${"ab".repeat(32)}&code=abcdefghij`, {
      headers: { ...auth, cookie: `dureview_github_setup=${state}`, origin: "https://github.com", "sec-fetch-site": "cross-site" },
      redirect: "manual",
    });
    expect(mismatch.status).toBe(303);
    expect(mismatch.headers.get("location")).toContain("github=failed");

    const failed = await fetch(`${http.url}${mismatch.headers.get("location")}`, { headers: auth });
    expect(await failed.text()).toContain("GitHub setup did not finish");

    const invalid = await settingsPost(http.url, UI_TOKEN, { action: "api-key", provider: "openai", key: "short" });
    expect(invalid.status).toBe(303);
    const problem = invalid.headers.get("location") ?? "";
    expect(problem).toContain("problem=");
    const shown = await fetch(`${http.url}${problem}`, { headers: auth });
    const shownHtml = await shown.text();
    expect(shownHtml).toContain("Enter an API key at least 8 characters long");
    expect(shownHtml).not.toContain(KEY);
  });

  it("posts the GitHub App manifest to the configured enterprise host", async () => {
    const dataDir = await tempDataDir();
    const { service } = await openTestService({
      dataDir,
      github: new MemoryGitHub(),
      responses: [],
      githubApiUrl: "https://ghe.example.com/api/v3",
    });
    const http = await startHttp(service, {
      host: "127.0.0.1",
      port: 0,
      uiToken: UI_TOKEN,
      dataDir,
      githubApiUrl: "https://ghe.example.com/api/v3",
    });
    closers.push(async () => {
      await http.close();
      await service.close();
    });
    const handoff = await settingsPost(http.url, UI_TOKEN, { action: "github-manifest", org: "acme" });
    expect(handoff.status).toBe(200);
    expect(handoff.headers.get("content-security-policy")).toContain("form-action https://ghe.example.com");
    expect(handoff.headers.get("content-security-policy")).not.toContain("form-action https://github.com");
    const html = await handoff.text();
    expect(html).toContain("https://ghe.example.com/organizations/acme/settings/apps/new");
    expect(html).not.toContain("https://github.com/settings/apps/new");
  });

  it("rejects a cross-site credential post even when HTTP Basic and the form token are present", async () => {
    const dataDir = await tempDataDir();
    const { service } = await openTestService({ dataDir, github: new MemoryGitHub(), responses: [] });
    const http = await startHttp(service, { host: "127.0.0.1", port: 0, uiToken: UI_TOKEN, dataDir });
    closers.push(async () => {
      await http.close();
      await service.close();
    });
    const basic = Buffer.from(`operator:${UI_TOKEN}`).toString("base64");
    const token = settingsCsrfToken(UI_TOKEN);
    const attack = await fetch(`${http.url}/ui/settings`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams({ action: "api-key", provider: "openai", key: KEY, csrf: token }),
    });
    expect(attack.status).toBe(403);
    const bare = await fetch(`${http.url}/ui/settings`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${UI_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(http.url).origin,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ action: "api-key", provider: "openai", key: KEY }),
    });
    expect(bare.status).toBe(403);
    const forged = await settingsPost(http.url, UI_TOKEN, { action: "api-key", provider: "openai", key: KEY }, { "sec-fetch-site": "same-site" });
    expect(forged.status).toBe(403);
    const page = await fetch(`${http.url}/ui/settings`, { headers: { authorization: `Bearer ${UI_TOKEN}` } });
    expect(await page.text()).not.toContain("9f3a");

    const request = new Request("https://review.example/ui/settings", {
      method: "POST",
      headers: { origin: "https://review.example", "sec-fetch-site": "same-origin" },
    });
    expect(postIsSameOrigin(request)).toBe(true);
    expect(postIsSameOrigin(new Request("http://127.0.0.1/ui/settings", { method: "POST" }))).toBe(false);
    expect(
      postIsSameOrigin(
        new Request("http://127.0.0.1/ui/settings", {
          method: "POST",
          headers: { origin: "https://review.example", "x-forwarded-proto": "https", "x-forwarded-host": "review.example" },
        }),
      ),
    ).toBe(true);
    expect(
      postIsSameOrigin(
        new Request("http://127.0.0.1/ui/settings", {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "evil.example",
          },
        }),
      ),
    ).toBe(false);
    expect(
      postIsSameOrigin(
        new Request("https://review.example/ui/settings", {
          method: "POST",
          headers: { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
        }),
      ),
    ).toBe(false);
  });
});

function settingsPost(url: string, token: string, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/ui/settings`, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
      origin: new URL(url).origin,
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: new URLSearchParams({ ...fields, csrf: settingsCsrfToken(token) }),
  });
}

function selectPrompt(): AuthPrompt {
  return {
    type: "select",
    message: "How do you want to sign in?",
    options: [
      { id: "browser", label: "Browser" },
      { id: "device_code", label: "Device code" },
    ],
  };
}
