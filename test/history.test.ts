import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_REVIEWS, ReviewLog } from "../src/review/history.js";
import { readCodexLogin } from "../src/ui/status.js";
import { formatUptime, pullRequestUrl, renderReviewList } from "../src/ui/page.js";
import type { DashboardStatus } from "../src/ui/status.js";
import type { ReviewSummary } from "../src/review/archive.js";
import { sampleFinding } from "./support.js";
import { authorizeUi } from "../src/ui/auth.js";
import { assertServeConfig, configFromEnv } from "../src/config.js";

const env = {
  DUREVIEW_WEBHOOK_SECRET: "webhook-secret",
  GITHUB_TOKEN: "github-token",
};

describe("ui token config", () => {
  it("leaves the page disabled when the token is unset or blank", () => {
    const disabled = configFromEnv(env);
    expect(disabled.uiToken).toBeUndefined();
    expect(() => assertServeConfig(disabled)).not.toThrow();
    expect(configFromEnv({ ...env, DUREVIEW_UI_TOKEN: "   " }).uiToken).toBeUndefined();
    expect(configFromEnv({ ...env, DUREVIEW_UI_TOKEN: "  page-token  " }).uiToken).toBe("page-token");
  });
});

describe("status page auth", () => {
  it("accepts bearer and basic passwords, including colons", () => {
    expect(authorizeUi(undefined, "secret")).toBe(false);
    expect(authorizeUi("Bearer secret", "secret")).toBe(true);
    expect(authorizeUi("bearer secret", "secret")).toBe(true);
    expect(authorizeUi("Bearer other", "secret")).toBe(false);
    expect(authorizeUi("Bearer secret", "")).toBe(false);
    const basic = Buffer.from("dureview:secret").toString("base64");
    expect(authorizeUi(`Basic ${basic}`, "secret")).toBe(true);
    const colonToken = Buffer.from("anyone:a:b:c").toString("base64");
    expect(authorizeUi(`Basic ${colonToken}`, "a:b:c")).toBe(true);
    expect(authorizeUi(`Basic ${basic}`, "a:b:c")).toBe(false);
    expect(authorizeUi("Basic bm90LWJhc2lj", "secret")).toBe(false);
  });
});

describe("codex login status", () => {
  it("reports presence and expiry without copying secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-login-"));
    expect(await readCodexLogin(dir)).toEqual({ present: false, expiresAt: null, unreadable: false });
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "ACCESS_TOKEN_CANARY_9f3a",
          refresh: "REFRESH_TOKEN_CANARY_bb12",
          expires: Date.parse("2030-01-02T03:04:05.000Z"),
          pem: "-----BEGIN PRIVATE KEY-----\nCANARY\n",
        },
        note: "WEBHOOK_SECRET_CANARY",
      }),
      { mode: 0o600 },
    );
    const status = await readCodexLogin(dir);
    expect(status).toEqual({
      present: true,
      expiresAt: "2030-01-02T03:04:05.000Z",
      unreadable: false,
    });
    expect(JSON.stringify(status)).not.toContain("CANARY");
    expect(JSON.stringify(status)).not.toContain("BEGIN PRIVATE KEY");

    await writeFile(join(dir, "auth.json"), "{", { mode: 0o600 });
    expect(await readCodexLogin(dir)).toEqual({ present: false, expiresAt: null, unreadable: true });

    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "api_key", key: "sk-CANARY" } }),
      { mode: 0o600 },
    );
    const apiKey = await readCodexLogin(dir);
    expect(apiKey.present).toBe(false);
    expect(JSON.stringify(apiKey)).not.toContain("sk-CANARY");
  });
});

describe("review log", () => {
  it("keeps the newest reviews and does not downgrade a finished one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-log-"));
    const file = join(dir, "reviews.json");
    const log = new ReviewLog(file);
    await log.finish({
      taskId: "9",
      owner: "acme",
      repo: "demo",
      number: 7,
      outcome: "completed",
      verdict: "clean",
      findingCount: 0,
    });
    await log.start({ taskId: "9", owner: "acme", repo: "demo", number: 7, trigger: "opened" });
    await log.start({ taskId: "10", owner: "acme", repo: "demo", number: 8, trigger: "command" });

    const reopened = new ReviewLog(file);
    const listed = await reopened.list();
    expect(listed.map((entry) => entry.taskId)).toEqual(["10", "9"]);
    expect(listed[1]).toMatchObject({
      outcome: "completed",
      trigger: "opened",
      verdict: "clean",
      findingCount: 0,
      number: 7,
    });
    expect(listed[0]).toMatchObject({ outcome: "running", trigger: "command", number: 8 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain("access");
    expect(saved).not.toContain("secret");

    await log.finish({
      taskId: "11",
      owner: "acme",
      repo: "demo",
      number: 9,
      outcome: "completed",
      verdict: "fix_recommended",
      findingCount: 1,
      title: "CANARY_TITLE",
      findings: [sampleFinding({ body: "CANARY_FINDING_BODY" })],
    });
    const withFinding = await readFile(file, "utf8");
    expect(withFinding).not.toContain("CANARY_FINDING_BODY");
    expect(withFinding).not.toContain("CANARY_TITLE");

    await log.finish({
      taskId: "12",
      owner: "acme",
      repo: "demo",
      number: 10,
      outcome: "failed",
      verdict: null,
      findingCount: null,
      error: "CANARY_ERROR_TEXT",
    });
    expect(await readFile(file, "utf8")).not.toContain("CANARY_ERROR_TEXT");
  });

  it("drops invalid rows and refuses to overwrite a corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-log-"));
    const file = join(dir, "reviews.json");
    const corrupt = `{not json ACCESS_TOKEN_CANARY`;
    await writeFile(file, corrupt, { mode: 0o600 });
    const log = new ReviewLog(file);
    await log.start({ taskId: "1", owner: "acme", repo: "demo", number: 1, trigger: "opened" });
    expect(await readFile(file, "utf8")).toBe(corrupt);
    expect(await log.list()).toEqual([]);

    await writeFile(
      file,
      JSON.stringify({
        reviews: [
          {
            taskId: "1",
            owner: "<script>",
            repo: "demo",
            number: 1,
            trigger: "opened",
            startedAt: new Date().toISOString(),
            finishedAt: null,
            outcome: "running",
            verdict: null,
            findingCount: null,
            access: "ACCESS_TOKEN_CANARY_9f3a",
          },
          {
            taskId: "2",
            owner: "acme",
            repo: "demo",
            number: 3,
            trigger: "synchronize",
            startedAt: "2026-10-13T15:00:00.000Z",
            finishedAt: "2026-10-13T15:01:00.000Z",
            outcome: "completed",
            verdict: "block",
            findingCount: 2,
            refresh: "REFRESH_TOKEN_CANARY_bb12",
          },
        ],
        webhookSecret: "WEBHOOK_SECRET_CANARY",
      }),
      { mode: 0o600 },
    );
    const listed = await log.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      taskId: "2",
      owner: "acme",
      repo: "demo",
      number: 3,
      trigger: "synchronize",
      startedAt: "2026-10-13T15:00:00.000Z",
      finishedAt: "2026-10-13T15:01:00.000Z",
      outcome: "completed",
      verdict: "block",
      findingCount: 2,
    });
    expect(JSON.stringify(listed)).not.toContain("CANARY");
    expect(JSON.stringify(listed)).not.toContain("<script>");
  });

  it("caps the log at the newest entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-log-"));
    const log = new ReviewLog(join(dir, "reviews.json"));
    for (let i = 1; i <= MAX_REVIEWS + 5; i += 1) {
      await log.start({ taskId: String(i), owner: "acme", repo: "demo", number: i, trigger: "opened" });
    }
    const listed = await log.list();
    expect(listed).toHaveLength(MAX_REVIEWS);
    expect(listed[0]?.taskId).toBe(String(MAX_REVIEWS + 5));
    expect(listed.some((entry) => entry.taskId === "1")).toBe(false);
  });
});

describe("review list rendering", () => {
  it("escapes text and builds pull request links without credentials", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(5_000)).toBe("5s");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatUptime(3_600_000)).toBe("1h 0m");
    expect(formatUptime(90_000_000)).toBe("1d 1h 0m");
    expect(pullRequestUrl("https://api.github.com", "acme", "demo", 7)).toBe("https://github.com/acme/demo/pull/7");
    expect(pullRequestUrl("https://ghe.example.com/api/v3", "acme", "demo", 7)).toBe(
      "https://ghe.example.com/acme/demo/pull/7",
    );
    expect(pullRequestUrl("https://user:secret@ghe.example.com/api/v3", "acme", "demo", 7)).toBe(
      "https://ghe.example.com/acme/demo/pull/7",
    );
    expect(pullRequestUrl("https://api.github.com", "acme", "<script>", 7)).toBeNull();
    expect(pullRequestUrl("javascript:alert(1)", "acme", "demo", 7)).toBeNull();

    const status: DashboardStatus = {
      version: "0.1.0",
      uptimeSeconds: 65,
      provider: "openai-codex",
      model: "<script>alert(1)</script>",
      codex: { present: true, expiresAt: "2030-01-02T03:04:05.000Z", unreadable: false },
      githubApp: true,
      githubToken: false,
    };
    const review: ReviewSummary = {
      taskId: "4",
      owner: "acme",
      repo: "demo",
      number: 7,
      title: "<script>alert(1)</script>",
      trigger: "command",
      startedAt: "2026-10-13T15:04:00.000Z",
      finishedAt: "2026-10-13T15:05:00.000Z",
      outcome: "completed",
      verdict: "fix_recommended",
      p0: 0,
      p1: 1,
      p2: 0,
      p3: 0,
      findingCount: 1,
      countsKnown: true,
    };
    const html = renderReviewList({
      status,
      reviews: [review],
      repos: ["acme/demo"],
      total: 1,
      form: { repo: "", result: "", since: "", from: "", to: "", q: "" },
      now: Date.parse("2026-10-13T15:05:00.000Z"),
    });
    expect(html).toContain("0.1.0");
    expect(html).toContain("1m 5s");
    expect(html).toContain("access token expires ");
    expect(html).toContain('datetime="2030-01-02T03:04:05.000Z"');
    expect(html).toContain("2030-01-02 03:04 UTC");
    expect(html).toContain("GitHub App <b>yes</b>");
    expect(html).toContain("GitHub token <b>no</b>");
    expect(html).toContain("/ui/reviews/4");
    expect(html).toContain("acme/demo #7");
    expect(html).toContain("/dureview");
    expect(html).toContain("P0/P1");
    expect(html).toContain("1m");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("secret");
  });
});
