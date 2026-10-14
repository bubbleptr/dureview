import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ReviewArchive } from "../src/review/archive.js";
import type { RepoCheckout } from "../src/review/checkout.js";
import { ReviewConfigError } from "../src/review/policy.js";
import { statsQueryFromSearch } from "../src/ui/stats-query.js";
import { MemoryGitHub, openTestService, reviewRequest, sampleFinding, scriptedReview, tempDataDir } from "./support.js";

describe("review statistics migration", () => {
  it("adds usage columns and a findings table without turning old rows into zeros", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-stats-"));
    const file = join(dir, "reviews.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE reviews (
        task_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        installation_id INTEGER,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        outcome TEXT NOT NULL,
        verdict TEXT,
        verdict_reason TEXT,
        overall_confidence REAL,
        checked_json TEXT NOT NULL DEFAULT '[]',
        policy_json TEXT,
        provider TEXT,
        model TEXT,
        p0 INTEGER NOT NULL DEFAULT 0,
        p1 INTEGER NOT NULL DEFAULT 0,
        p2 INTEGER NOT NULL DEFAULT 0,
        p3 INTEGER NOT NULL DEFAULT 0,
        finding_count INTEGER,
        counts_known INTEGER NOT NULL DEFAULT 1,
        error TEXT
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO reviews (
        task_id, owner, repo, number, title, sha, base_sha, base_ref, trigger, started_at, finished_at, outcome, verdict
      ) VALUES ('old', 'acme', 'demo', 1, 'Legacy', 'abc', '', '', 'opened', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'completed', 'clean')`,
    ).run();
    db.close();

    const archive = new ReviewArchive(file);
    await archive.open();
    await archive.finish({
      taskId: "new",
      owner: "acme",
      repo: "demo",
      number: 2,
      outcome: "completed",
      verdict: "fix_recommended",
      findingCount: 1,
      sha: "def",
      findings: [sampleFinding({ cwe: "CWE-20", ruleRef: "pay.check" })],
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 15,
        reasoningTokens: null,
        modelCalls: 2,
        costUsd: 0.01,
      },
      provider: "openai-codex",
      modelId: "gpt-5.5",
    });
    archive.close();

    const check = new DatabaseSync(file, { readOnly: true });
    const columns = new Set(check.prepare("PRAGMA table_info(reviews)").all().map((row) => String(row.name)));
    for (const name of ["input_tokens", "output_tokens", "cache_read_tokens", "reasoning_tokens", "model_calls", "cost_usd"]) {
      expect(columns.has(name)).toBe(true);
    }
    const legacy = check.prepare("SELECT input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, model_calls, cost_usd FROM reviews WHERE task_id = 'old'").get() as UsageRow;
    expect(legacy).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      reasoning_tokens: null,
      model_calls: null,
      cost_usd: null,
    });
    const created = check.prepare("SELECT input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, model_calls, cost_usd FROM reviews WHERE task_id = 'new'").get() as UsageRow;
    expect(created).toMatchObject({
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 15,
      reasoning_tokens: null,
      model_calls: 2,
      cost_usd: 0.01,
    });
    const finding = check.prepare("SELECT category, cwe, rule_ref, extension, language, posted, skip_reason FROM findings WHERE task_id = 'new'").get() as Record<string, unknown>;
    expect(finding).toMatchObject({
      category: "correctness",
      cwe: "CWE-20",
      rule_ref: "pay.check",
      extension: "ts",
      language: "typescript",
      posted: null,
      skip_reason: null,
    });
    const indexes = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'findings'")
      .all()
      .map((row) => String(row.name));
    expect(indexes).toEqual(
      expect.arrayContaining([
        "findings_task",
        "findings_repo",
        "findings_category",
        "findings_fingerprint",
        "findings_created",
        "findings_language",
        "findings_path",
      ]),
    );
    check.close();
  });
});

describe("review statistics aggregation", () => {
  it("aggregates in SQL and does not treat unknown usage as zero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-stats-"));
    const file = join(dir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    archive.close();
    const db = new DatabaseSync(file);
    insertReview(db, {
      taskId: "a",
      owner: "acme",
      repo: "demo",
      number: 1,
      title: "Slow billing",
      startedAt: "2026-10-10T20:30:00.000Z",
      finishedAt: "2026-10-10T20:30:10.000Z",
      outcome: "completed",
      verdict: "block",
      p0: 1,
      model: "gpt-5.5",
      input: 1000,
      output: 100,
      cache: 50,
      reasoning: 20,
      calls: 4,
      cost: 0.2,
      error: null,
    });
    insertReview(db, {
      taskId: "b",
      owner: "acme",
      repo: "demo",
      number: 1,
      title: "Slow billing",
      startedAt: "2026-10-11T01:00:00.000Z",
      finishedAt: "2026-10-11T01:00:20.000Z",
      outcome: "completed",
      verdict: "fix_recommended",
      p1: 2,
      model: "gpt-5.5",
      input: 500,
      output: 50,
      cache: null,
      reasoning: null,
      calls: 2,
      cost: 0.05,
      error: null,
    });
    insertReview(db, {
      taskId: "c",
      owner: "acme",
      repo: "demo",
      number: 2,
      title: "Rename",
      startedAt: "2026-10-12T00:00:00.000Z",
      finishedAt: "2026-10-12T00:00:30.000Z",
      outcome: "completed",
      verdict: "clean",
      model: "gpt-5.4",
      input: 10,
      output: 1,
      cache: 0,
      reasoning: null,
      calls: 1,
      cost: null,
      error: null,
    });
    insertReview(db, {
      taskId: "d",
      owner: "other",
      repo: "app",
      number: 9,
      title: "Boom",
      startedAt: "2026-10-12T03:00:00.000Z",
      finishedAt: "2026-10-12T03:00:40.000Z",
      outcome: "failed",
      verdict: null,
      model: "gpt-5.5",
      input: null,
      output: null,
      cache: null,
      reasoning: null,
      calls: null,
      cost: null,
      error: "Review run did not finish: error",
    });
    insertReview(db, {
      taskId: "e",
      owner: "other",
      repo: "app",
      number: 9,
      title: "Boom",
      startedAt: "2026-10-12T04:00:00.000Z",
      finishedAt: "2026-10-12T04:01:40.000Z",
      outcome: "failed",
      verdict: null,
      model: "gpt-5.5",
      input: 8,
      output: 1,
      cache: null,
      reasoning: null,
      calls: 1,
      cost: null,
      error: "Review run did not finish: error",
    });
    insertReview(db, {
      taskId: "f",
      owner: "acme",
      repo: "demo",
      number: 3,
      title: "Running",
      startedAt: "2026-10-13T00:00:00.000Z",
      finishedAt: null,
      outcome: "running",
      verdict: null,
      model: null,
      input: null,
      output: null,
      cache: null,
      reasoning: null,
      calls: null,
      cost: null,
      error: null,
    });
    insertReview(db, {
      taskId: "g",
      owner: "acme",
      repo: "demo",
      number: 4,
      title: "Ancient",
      startedAt: "2026-08-01T00:00:00.000Z",
      finishedAt: "2026-08-01T00:02:00.000Z",
      outcome: "completed",
      verdict: "clean",
      model: "gpt-5.5",
      input: 9_999,
      output: 9_999,
      cache: 0,
      reasoning: 0,
      calls: 1,
      cost: 50,
      error: null,
    });
    db.prepare(
      `INSERT INTO findings (
        task_id, owner, repo, number, sha, title, body, trigger_text, priority, kind, category,
        cwe, rule_ref, confidence, path, start_line, end_line, extension, language, fingerprint,
        posted, skip_reason, created_at
      ) VALUES
        ('a', 'acme', 'demo', 1, 'abc', 'Dropped', 'body', 'trigger', 0, 'bug', 'correctness', NULL, NULL, 0.9, 'src/pay.ts', 2, 2, 'ts', 'typescript', 'aaaaaaaaaaaa', 1, NULL, '2026-10-10T20:30:10.000Z'),
        ('a', 'acme', 'demo', 1, 'abc', 'Hidden', 'body', '', 3, 'investigate', 'security', 'CWE-89', NULL, 0.4, 'src/pay.ts', 4, 4, 'ts', 'typescript', 'bbbbbbbbbbbb', 0, 'investigate', '2026-10-10T20:30:10.000Z'),
        ('b', 'acme', 'demo', 1, 'abc', 'Retry', 'body', 'trigger', 1, 'bug', 'error_handling', NULL, NULL, 0.8, 'src/pay.ts', 3, 3, 'ts', 'typescript', 'cccccccccccc', 1, NULL, '2026-10-11T01:00:20.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO comments (
        task_id, ordinal, path, start_line, end_line, priority, kind, category, title, body, trigger_text, confidence, fingerprint, evidence_json
      ) VALUES ('c', 0, 'src/old.ts', 1, 1, 2, 'bug', 'test_gap', 'Old', 'body', 'trigger', 0.7, 'dddddddddddd', '[]')`,
    ).run();
    db.close();

    const again = new ReviewArchive(file);
    await again.open();
    const all = await again.stats({ repo: "", since: null, tzOffsetMinutes: 480 });
    expect(all.reviews).toBe(7);
    expect(all.completed).toBe(4);
    expect(all.failed).toBe(2);
    expect(all.running).toBe(1);
    expect(all.durationSamples).toBe(6);
    expect(all.avgDurationMs).toBeCloseTo((10 + 20 + 30 + 40 + 100 + 120) * 1000 / 6, 0);
    expect(all.p95DurationMs).toBeCloseTo(120_000, 0);
    expect(all.failures).toEqual([{ reason: "Review run did not finish: error", count: 2 }]);
    expect(all.priorities).toMatchObject({ p0: 1, p1: 1, p2: 0, p3: 1, unknownReviews: 0 });
    expect(all.categories).toEqual([
      { category: "correctness", count: 1 },
      { category: "error_handling", count: 1 },
      { category: "security", count: 1 },
      { category: "test_gap", count: 1 },
    ]);
    expect(all.verdicts).toEqual({ block: 1, fixRecommended: 1, clean: 2, unknown: 0 });
    expect(all.tokens.knownReviews).toBe(5);
    expect(all.tokens.unknownReviews).toBe(2);
    expect(all.tokens.totalInput).toBe(1000 + 500 + 10 + 8 + 9999);
    expect(all.tokens.avgTotal).toBeCloseTo((1000 + 100 + 50 + 500 + 50 + 10 + 1 + 0 + 8 + 1 + 9999 + 9999) / 5, 5);
    expect(all.tokens.totalReasoning).toBe(20);
    expect(all.tokens.totalCostUsd).toBeCloseTo(50.25, 5);
    const days = all.trend.filter((row) => row.model === "gpt-5.5").map((row) => row.day);
    expect(days).toContain("2026-10-11");
    expect(days).toContain("2026-10-12");
    expect(days).toContain("2026-08-01");
    expect(all.trend.find((row) => row.day === "2026-10-11" && row.model === "gpt-5.5")?.totalTokens).toBe(1150 + 550);
    expect(all.expensive[0]).toMatchObject({ repo: "acme/demo", number: 4, costUsd: 50 });
    expect(all.topRepos[0]).toMatchObject({ repo: "acme/demo", reviews: 5 });
    expect(all.topPulls[0]?.findings).toBeGreaterThan(0);

    const week = await again.stats({ repo: "acme/demo", since: "2026-10-01T00:00:00.000Z", tzOffsetMinutes: 0 });
    expect(week.reviews).toBe(4);
    expect(week.tokens.totalInput).toBe(1000 + 500 + 10);
    expect(week.tokens.unknownReviews).toBe(1);
    expect(week.expensive.map((row) => row.number)).not.toContain(4);
    expect(week.topRepos).toEqual([{ repo: "acme/demo", reviews: 4, findings: 3 }]);
    again.close();
  });
});

describe("usage capture", () => {
  it("stores pi-ai usage and a posted finding after a review, and still records a failed run", async () => {
    const dataDir = await tempDataDir();
    const { service } = await openTestService({
      dataDir,
      github: new MemoryGitHub(),
      responses: scriptedReview("charge() reports success without billing.", [
        sampleFinding({ cwe: "CWE-682", ruleRef: "pay.capture" }),
      ]),
    });
    const queued = await service.enqueue(reviewRequest(), { kind: "sha" }, "opened");
    const settled = await service.wait(queued.taskId);
    expect(settled.state.outcome.status).toBe("completed");
    await service.close();

    const db = new DatabaseSync(join(dataDir, "reviews.sqlite"), { readOnly: true });
    const usage = db.prepare("SELECT input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, model_calls, cost_usd, model, outcome FROM reviews").get() as UsageRow & { model: string; outcome: string };
    expect(usage.outcome).toBe("completed");
    expect(usage.model).toBe("faux-1");
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.model_calls).toBeGreaterThanOrEqual(3);
    expect(usage.cache_read_tokens).not.toBeNull();
    expect(usage.reasoning_tokens).toBeNull();
    expect(usage.cost_usd).toBe(0);
    const finding = db.prepare("SELECT posted, skip_reason, cwe, rule_ref, extension, language, body FROM findings").get() as Record<string, unknown>;
    expect(finding).toMatchObject({
      posted: 1,
      skip_reason: null,
      cwe: "CWE-682",
      rule_ref: "pay.capture",
      extension: "ts",
      language: "typescript",
    });
    expect(finding.body).toContain("never billed");
    db.close();
  });

  it("records usage when the model fails, and leaves usage unknown when the run never calls a model", async () => {
    const failedDir = await tempDataDir();
    const failed = await openTestService({
      dataDir: failedDir,
      github: new MemoryGitHub(),
      responses: [
        fauxAssistantMessage("I am done.", { stopReason: "stop" }),
        fauxAssistantMessage("Still done.", { stopReason: "stop" }),
      ],
    });
    const failedTask = await failed.service.enqueue(reviewRequest());
    expect((await failed.service.wait(failedTask.taskId)).state.outcome.status).toBe("failed");
    await failed.service.close();
    const failedDb = new DatabaseSync(join(failedDir, "reviews.sqlite"), { readOnly: true });
    const failedUsage = failedDb.prepare("SELECT input_tokens, model_calls, outcome FROM reviews").get() as UsageRow & { outcome: string };
    expect(failedUsage.outcome).toBe("failed");
    expect(failedUsage.input_tokens).toBeGreaterThan(0);
    expect(failedUsage.model_calls).toBeGreaterThanOrEqual(2);
    failedDb.close();

    const configDir = await tempDataDir();
    const checkout: RepoCheckout = {
      async prepare() {
        throw new ReviewConfigError("bad profile");
      },
    };
    const config = await openTestService({ dataDir: configDir, github: new MemoryGitHub(), responses: [], checkout });
    const configTask = await config.service.enqueue(reviewRequest());
    expect((await config.service.wait(configTask.taskId)).state.outcome.status).toBe("failed");
    await config.service.close();
    const configDb = new DatabaseSync(join(configDir, "reviews.sqlite"), { readOnly: true });
    const configUsage = configDb.prepare("SELECT input_tokens, output_tokens, model_calls, cost_usd, model FROM reviews").get() as UsageRow & { model: string };
    expect(configUsage.input_tokens).toBeNull();
    expect(configUsage.output_tokens).toBeNull();
    expect(configUsage.model_calls).toBeNull();
    expect(configUsage.cost_usd).toBeNull();
    expect(configUsage.model).toBe("faux-1");
    expect(configDb.prepare("SELECT COUNT(*) AS n FROM findings").get()).toMatchObject({ n: 0 });
    configDb.close();
  });
});

describe("statistics query", () => {
  it("accepts the time range and repo and ignores the rest", () => {
    const parsed = statsQueryFromSearch(
      new URLSearchParams({ range: "24h", repo: "acme/demo", tz: "480" }),
      Date.parse("2026-10-14T00:00:00.000Z"),
    );
    expect(parsed.form).toEqual({ range: "24h", repo: "acme/demo", tz: 480 });
    expect(parsed.query.since).toBe("2026-10-13T00:00:00.000Z");
    expect(parsed.query.tzOffsetMinutes).toBe(480);

    const fallback = statsQueryFromSearch(new URLSearchParams({ range: "year", repo: "../secret", tz: "nope" }), Date.parse("2026-10-14T00:00:00.000Z"));
    expect(fallback.form).toEqual({ range: "7d", repo: "", tz: 0 });
    expect(fallback.query.since).toBe("2026-10-07T00:00:00.000Z");
  });
});

type UsageRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  reasoning_tokens: number | null;
  model_calls: number | null;
  cost_usd: number | null;
};

function insertReview(
  db: DatabaseSync,
  row: {
    taskId: string;
    owner: string;
    repo: string;
    number: number;
    title: string;
    startedAt: string;
    finishedAt: string | null;
    outcome: string;
    verdict: string | null;
    p0?: number;
    p1?: number;
    p2?: number;
    p3?: number;
    model: string | null;
    input: number | null;
    output: number | null;
    cache: number | null;
    reasoning: number | null;
    calls: number | null;
    cost: number | null;
    error: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO reviews (
      task_id, owner, repo, number, title, sha, base_sha, base_ref, trigger, started_at, finished_at,
      outcome, verdict, p0, p1, p2, p3, finding_count, counts_known, error, provider, model,
      input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, model_calls, cost_usd
    ) VALUES (?, ?, ?, ?, ?, 'abc', '', '', 'opened', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'openai-codex', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.taskId,
    row.owner,
    row.repo,
    row.number,
    row.title,
    row.startedAt,
    row.finishedAt,
    row.outcome,
    row.verdict,
    row.p0 ?? 0,
    row.p1 ?? 0,
    row.p2 ?? 0,
    row.p3 ?? 0,
    (row.p0 ?? 0) + (row.p1 ?? 0) + (row.p2 ?? 0) + (row.p3 ?? 0),
    row.error,
    row.model,
    row.input,
    row.output,
    row.cache,
    row.reasoning,
    row.calls,
    row.cost,
  );
}
