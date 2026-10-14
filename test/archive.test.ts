import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ReviewArchive, reviewResult } from "../src/review/archive.js";
import { reviewFilterFromSearch } from "../src/ui/query.js";
import { ReviewLog } from "../src/review/history.js";
import { defaultPolicy } from "../src/review/policy.js";
import { sampleFinding } from "./support.js";

describe("review archive", () => {
  it("stores structured comments and filters the list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-archive-"));
    const file = join(dir, "reviews.sqlite");
    const archive = new ReviewArchive(file);
    await archive.open();
    await archive.start(row("1", "acme", "demo", 7, "opened", "Charge positive amounts"));
    await archive.finish({
      taskId: "1",
      owner: "acme",
      repo: "demo",
      number: 7,
      outcome: "completed",
      verdict: "fix_recommended",
      findingCount: 2,
      title: "Charge positive amounts",
      sha: "a".repeat(40),
      installationId: 99,
      verdictReason: "Billing is skipped.",
      policy: { ...defaultPolicy(), trigger: "auto" },
      findings: [
        sampleFinding({ priority: 0, title: "Dropped charge", startLine: 2, endLine: 3 }),
        sampleFinding({
          priority: 2,
          title: "Missing test",
          path: "src/pay.test.ts",
          startLine: 4,
          endLine: 4,
          category: "test_gap",
        }),
      ],
      provider: "faux",
      modelId: "faux-1",
    });
    await archive.start(row("2", "other", "app", 3, "command", "Clean rename"));
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
    await archive.start(row("3", "acme", "demo", 8, "synchronize", "Boom"));
    await archive.finish({
      taskId: "3",
      owner: "acme",
      repo: "demo",
      number: 8,
      outcome: "failed",
      verdict: null,
      findingCount: null,
    });

    const all = await archive.list({ repo: "", result: "", since: null, until: null, q: "" });
    expect(all.total).toBe(3);
    expect(all.repos).toEqual(["acme/demo", "other/app"]);
    expect(all.reviews.map((review) => review.taskId)).toEqual(["3", "2", "1"]);
    expect(reviewResult(all.reviews[2]!)).toBe("blocker");
    expect(reviewResult(all.reviews[1]!)).toBe("pass");
    expect(reviewResult(all.reviews[0]!)).toBe("error");

    const blockers = await archive.list({ repo: "acme/demo", result: "blocker", since: null, until: null, q: "charge" });
    expect(blockers.reviews.map((review) => review.taskId)).toEqual(["1"]);

    const passes = await archive.list({ repo: "", result: "pass", since: null, until: null, q: "" });
    expect(passes.reviews.map((review) => review.taskId)).toEqual(["2"]);

    const none = await archive.list({ repo: "", result: "", since: null, until: null, q: "100%" });
    expect(none.reviews).toEqual([]);
    const later = await archive.list({
      repo: "",
      result: "",
      since: "2999-01-01T00:00:00.000Z",
      until: null,
      q: "",
    });
    expect(later.reviews).toEqual([]);

    const detail = await archive.get("1");
    expect(detail?.p0).toBe(1);
    expect(detail?.p2).toBe(1);
    expect(detail?.installationId).toBe(99);
    expect(detail?.policy?.trigger).toBe("auto");
    expect(detail?.comments.map((comment) => [comment.path, comment.startLine, comment.endLine, comment.priority])).toEqual([
      ["src/pay.ts", 2, 3, 0],
      ["src/pay.test.ts", 4, 4, 2],
    ]);
    expect(detail?.comments[0]?.body).toContain("never billed");
    expect(detail?.provider).toBe("faux");
    expect(detail?.error).toBeNull();
    const failed = await archive.get("3");
    expect(failed?.error).toBeNull();

    const again = new ReviewArchive(file);
    await again.open();
    const reloaded = await again.get("1");
    expect(reloaded?.comments).toHaveLength(2);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const raw = await readFile(file);
    expect(raw.toString("utf8")).toContain("never billed");
    expect(raw.toString("utf8")).not.toContain("if (amount > 0) return { ok: true };");
    again.close();
    archive.close();
  });

  it("imports the short log without inventing per-priority counts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-archive-"));
    const legacy = join(dir, "reviews.json");
    const log = new ReviewLog(legacy);
    await log.finish({
      taskId: "9",
      owner: "acme",
      repo: "demo",
      number: 4,
      outcome: "completed",
      verdict: "fix_recommended",
      findingCount: 2,
    });
    const archive = new ReviewArchive(join(dir, "reviews.sqlite"), legacy);
    await archive.open();
    const listed = await archive.list({ repo: "", result: "suggest", since: null, until: null, q: "" });
    expect(listed.reviews).toHaveLength(1);
    expect(listed.reviews[0]?.countsKnown).toBe(false);
    expect(listed.reviews[0]?.p0).toBe(0);
    expect(reviewResult(listed.reviews[0]!)).toBe("suggest");
    const detail = await archive.get("9");
    expect(detail?.comments).toEqual([]);
    expect(detail?.title).toBe("");
    archive.close();
  });

  it("does not import over an archive that already has rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-archive-"));
    const file = join(dir, "reviews.sqlite");
    const legacy = join(dir, "reviews.json");
    const first = new ReviewArchive(file, legacy);
    await first.open();
    await first.start(row("1", "acme", "demo", 1, "opened", "Kept"));
    first.close();
    const log = new ReviewLog(legacy);
    await log.start({ taskId: "2", owner: "acme", repo: "demo", number: 2, trigger: "opened" });
    const second = new ReviewArchive(file, legacy);
    await second.open();
    const listed = await second.list({ repo: "", result: "", since: null, until: null, q: "" });
    expect(listed.reviews.map((review) => review.taskId)).toEqual(["1"]);
    second.close();
  });

  it("migrates an archive that has no error column and stores the failure reason", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-archive-"));
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
        counts_known INTEGER NOT NULL DEFAULT 1
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO reviews (
        task_id, owner, repo, number, title, sha, base_sha, base_ref, trigger, started_at, outcome
      ) VALUES ('4', 'acme', 'demo', 11, 'Old row', '', '', '', 'opened', '2026-10-13T00:00:00.000Z', 'running')`,
    ).run();
    db.close();

    const archive = new ReviewArchive(file);
    await archive.open();
    await archive.finish({
      taskId: "4",
      owner: "acme",
      repo: "demo",
      number: 11,
      outcome: "failed",
      verdict: null,
      findingCount: null,
      error: `clone failed\0${"x".repeat(2100)}`,
    });
    const detail = await archive.get("4");
    expect(detail?.outcome).toBe("failed");
    expect(detail?.error?.startsWith("clone failed")).toBe(true);
    expect(detail?.error).not.toContain("\0");
    expect(detail?.error?.length).toBe(2000);
    archive.close();
  });

  it("adds nullable finding type columns and leaves existing rows unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-archive-"));
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
        counts_known INTEGER NOT NULL DEFAULT 1
      ) STRICT;
      CREATE TABLE comments (
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        suggestion TEXT,
        confidence REAL NOT NULL,
        fingerprint TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        PRIMARY KEY (task_id, ordinal)
      ) STRICT;
      CREATE TABLE findings (
        id INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        sha TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        priority INTEGER NOT NULL,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        cwe TEXT,
        rule_ref TEXT,
        confidence REAL NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        extension TEXT,
        language TEXT,
        fingerprint TEXT NOT NULL,
        posted INTEGER,
        skip_reason TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO reviews (
        task_id, owner, repo, number, title, sha, base_sha, base_ref, trigger, started_at, outcome, p0
      ) VALUES ('old', 'acme', 'demo', 1, 'Old', 'abc', '', '', 'opened', '2026-10-01T00:00:00.000Z', 'completed', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO findings (
        task_id, owner, repo, number, sha, title, body, trigger_text, priority, kind, category,
        confidence, path, start_line, end_line, fingerprint, posted, created_at
      ) VALUES (
        'old', 'acme', 'demo', 1, 'abc', 'Legacy', 'body', 'trigger', 1, 'bug', 'correctness',
        0.9, 'src/pay.ts', 2, 2, 'aaaaaaaaaaaa', 1, '2026-10-01T00:00:00.000Z'
      )`,
    ).run();
    db.prepare(
      `INSERT INTO comments (
        task_id, ordinal, path, start_line, end_line, priority, kind, category, title, body,
        trigger_text, confidence, fingerprint, evidence_json
      ) VALUES ( 'old', 0, 'src/pay.ts', 2, 2, 1, 'bug', 'correctness', 'Legacy', 'body', 'trigger', 0.9, 'aaaaaaaaaaaa', '[]')`,
    ).run();
    db.close();

    const archive = new ReviewArchive(file);
    await archive.open();
    const legacy = new DatabaseSync(file, { readOnly: true });
    const columns = legacy
      .prepare("PRAGMA table_info(findings)")
      .all()
      .map((row) => String(row.name));
    expect(columns).toEqual(expect.arrayContaining(["finding_type", "subtype"]));
    expect(legacy.prepare("SELECT finding_type, subtype FROM findings WHERE task_id = 'old'").get()).toEqual({
      finding_type: null,
      subtype: null,
    });
    expect(legacy.prepare("SELECT finding_type, subtype FROM comments WHERE task_id = 'old'").get()).toEqual({
      finding_type: null,
      subtype: null,
    });
    legacy.close();

    await archive.start(row("new", "acme", "demo", 2, "opened", "Typed"));
    await archive.finish({
      taskId: "new",
      owner: "acme",
      repo: "demo",
      number: 2,
      outcome: "completed",
      verdict: "fix_recommended",
      findingCount: 1,
      sha: "abc",
      findings: [sampleFinding({ type: "security", subtype: "critical", kind: "security", cwe: "CWE-89", priority: 0 })],
    });
    const stored = new DatabaseSync(file, { readOnly: true });
    expect(stored.prepare("SELECT finding_type, subtype, cwe FROM findings WHERE task_id = 'new'").get()).toEqual({
      finding_type: "security",
      subtype: "critical",
      cwe: "CWE-89",
    });
    expect(stored.prepare("SELECT finding_type, subtype FROM comments WHERE task_id = 'new'").get()).toEqual({
      finding_type: "security",
      subtype: "critical",
    });
    const oldStill = stored.prepare("SELECT finding_type FROM findings WHERE task_id = 'old'").get() as {
      finding_type: string | null;
    };
    expect(oldStill.finding_type).toBeNull();
    stored.close();
    const detail = await archive.get("old");
    expect(detail?.comments[0]?.findingType).toBeNull();
    archive.close();
  });
});

describe("review list query", () => {
  it("keeps safe filters and ignores the rest", () => {
    const now = Date.parse("2026-10-13T00:00:00.000Z");
    const parsed = reviewFilterFromSearch(
      new URLSearchParams({
        repo: "acme/demo",
        result: "blocker",
        since: "7d",
        from: "2026-10-01",
        to: "2026-10-13",
        q: "  pay  ",
      }),
      now,
    );
    expect(parsed.form).toMatchObject({ repo: "acme/demo", result: "blocker", since: "7d", q: "pay" });
    expect(parsed.filter.since).toBe("2026-10-06T00:00:00.000Z");
    expect(parsed.filter.until).toBe("2026-10-13T23:59:59.999Z");

    const rejected = reviewFilterFromSearch(
      new URLSearchParams({ repo: "../secret", result: "nope", since: "1y", from: "2026-02-31", q: "x" }),
      now,
    );
    expect(rejected.form).toEqual({ repo: "", result: "", since: "", from: "", to: "", q: "x" });
  });
});

function row(taskId: string, owner: string, repo: string, number: number, trigger: string, title: string) {
  return {
    taskId,
    owner,
    repo,
    number,
    title,
    sha: "abc",
    baseSha: "def",
    baseRef: "main",
    installationId: 99,
    trigger,
  };
}
