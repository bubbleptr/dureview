import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { log } from "../log.js";
import type { ReviewFinished } from "./history.js";
import { ReviewLog } from "./history.js";
import type { ReviewPolicy } from "./policy.js";
import { findingFingerprint, normalizeRepoPath, type Finding, type Priority } from "./schema.js";

/** SQLite file in the data directory. Mode 0600. Diffs are not stored here. */
export const REVIEWS_DB_FILE = "reviews.sqlite";

const NAME = /^[A-Za-z0-9_.-]+$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRIGGERS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "command", "unknown"]);
const FINGERPRINT = /^[0-9a-f]{12}$/;
const MAX_FINDINGS = 30;

export type ReviewResultKind = "pass" | "suggest" | "blocker" | "error" | "running";

export type ReviewFilter = {
  /** `owner/repo`, or empty for every repository. */
  repo: string;
  result: "" | ReviewResultKind;
  /** Inclusive ISO timestamp. Null means no lower bound. */
  since: string | null;
  /** Inclusive ISO timestamp. Null means no upper bound. */
  until: string | null;
  q: string;
};

export type StoredPolicy = {
  profile: string;
  trigger: string;
  drafts: boolean;
  language: string;
  summary: boolean;
  minConfidence: number;
  minInlinePriority: number;
  p2InlineMinConfidence: number;
  maxInline: number;
};

export type StoredComment = {
  ordinal: number;
  path: string;
  startLine: number;
  endLine: number;
  priority: Priority;
  kind: string;
  category: string;
  title: string;
  body: string;
  trigger: string;
  suggestion: string | null;
  confidence: number;
  fingerprint: string;
  evidence: string[];
};

export type ReviewSummary = {
  taskId: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "running" | "completed" | "failed";
  verdict: "block" | "fix_recommended" | "clean" | null;
  p0: number;
  p1: number;
  p2: number;
  p3: number;
  /** Total findings when per-priority counts were not stored (imported log rows). */
  findingCount: number | null;
  /** False for rows imported from `reviews.json`, which only had a total. */
  countsKnown: boolean;
};

export type ReviewDetail = ReviewSummary & {
  sha: string;
  baseSha: string;
  baseRef: string;
  installationId: number | null;
  verdictReason: string | null;
  overallConfidence: number | null;
  checked: string[];
  provider: string | null;
  model: string | null;
  policy: StoredPolicy | null;
  comments: StoredComment[];
  /** Failure reason when `outcome` is `failed`. Null for other rows and for legacy archives. */
  error: string | null;
};

export type ReviewList = {
  reviews: ReviewSummary[];
  repos: string[];
  /** Rows in the archive before filters. */
  total: number;
};

type Identity = { taskId: string; owner: string; repo: string; number: number };

/**
 * Review metadata and structured comments (path + line range) in the data directory.
 * The pull request diff is not written here. Callers load it from GitHub when a review is opened.
 * Writes are serialized in-process.
 */
export class ReviewArchive {
  #db: DatabaseSync | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly legacyPath?: string,
  ) {}

  async open(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS reviews (
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
      CREATE TABLE IF NOT EXISTS comments (
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
        PRIMARY KEY (task_id, ordinal),
        FOREIGN KEY (task_id) REFERENCES reviews(task_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reviews_started ON reviews(started_at DESC);
    `);
    migrateReviews(db);
    this.#db = db;
    await chmod(this.file, 0o600);
    await this.#importLegacy();
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  start(input: {
    taskId: string;
    owner: string;
    repo: string;
    number: number;
    title: string;
    sha: string;
    baseSha: string;
    baseRef: string;
    installationId: number | null;
    trigger: string;
  }): Promise<void> {
    const identity = cleanIdentity(input);
    if (!identity) return Promise.resolve();
    const trigger = TRIGGERS.has(input.trigger) ? input.trigger : "unknown";
    const startedAt = new Date().toISOString();
    const title = clip(input.title, 300);
    const sha = clip(input.sha, 64);
    const baseSha = clip(input.baseSha, 64);
    const baseRef = clip(input.baseRef, 200);
    const installationId = cleanInstallation(input.installationId);
    return this.#exclusive(() => {
      const db = this.#database();
      const existing = db.prepare("SELECT outcome, trigger FROM reviews WHERE task_id = ?").get(identity.taskId);
      if (existing) {
        if (str(existing, "trigger") === "unknown" && trigger !== "unknown") {
          db.prepare("UPDATE reviews SET trigger = ? WHERE task_id = ?").run(trigger, identity.taskId);
        }
        return;
      }
      db.prepare(
        `INSERT INTO reviews (
          task_id, owner, repo, number, title, sha, base_sha, base_ref, installation_id,
          trigger, started_at, finished_at, outcome, verdict, verdict_reason, overall_confidence,
          checked_json, policy_json, provider, model, p0, p1, p2, p3, finding_count, counts_known
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL, '[]', NULL, NULL, NULL, 0, 0, 0, 0, NULL, 1)`,
      ).run(
        identity.taskId,
        identity.owner,
        identity.repo,
        identity.number,
        title,
        sha,
        baseSha,
        baseRef,
        installationId,
        trigger,
        startedAt,
      );
    });
  }

  finish(event: ReviewFinished): Promise<void> {
    const identity = cleanIdentity(event);
    if (!identity) return Promise.resolve();
    if (event.outcome !== "completed" && event.outcome !== "failed") return Promise.resolve();
    const finishedAt = new Date().toISOString();
    const failed = event.outcome === "failed";
    const verdict = failed ? null : cleanVerdict(event.verdict);
    const comments = failed ? [] : cleanComments(event.findings);
    const counts = countPriorities(comments);
    const findingCount = failed ? null : comments.length > 0 ? comments.length : cleanCount(event.findingCount);
    const countsKnown = failed ? 1 : event.findings ? 1 : 0;
    const verdictReason = failed ? null : clip(event.verdictReason ?? "", 300) || null;
    const overall = failed ? null : cleanConfidence(event.overallConfidence);
    const checked = JSON.stringify(cleanChecked(event.checked));
    const policy = policyJson(event.policy);
    const provider = clip(event.provider ?? "", 80) || null;
    const model = clip(event.modelId ?? "", 80) || null;
    const title = clip(event.title ?? "", 300);
    const sha = clip(event.sha ?? "", 64);
    const baseSha = clip(event.baseSha ?? "", 64);
    const baseRef = clip(event.baseRef ?? "", 200);
    const installationId = cleanInstallation(event.installationId);
    const errorText = failed ? cleanError(event.error) : null;
    return this.#exclusive(() => {
      const db = this.#database();
      db.exec("BEGIN");
      try {
        const existing = db.prepare("SELECT task_id, trigger, title, sha FROM reviews WHERE task_id = ?").get(identity.taskId);
        if (existing) {
          db.prepare(
            `UPDATE reviews SET
              finished_at = ?, outcome = ?, verdict = ?, verdict_reason = ?, overall_confidence = ?,
              checked_json = ?, policy_json = COALESCE(?, policy_json),
              provider = COALESCE(?, provider), model = COALESCE(?, model),
              title = CASE WHEN ? != '' THEN ? ELSE title END,
              sha = CASE WHEN ? != '' THEN ? ELSE sha END,
              base_sha = CASE WHEN ? != '' THEN ? ELSE base_sha END,
              base_ref = CASE WHEN ? != '' THEN ? ELSE base_ref END,
              installation_id = COALESCE(?, installation_id),
              p0 = ?, p1 = ?, p2 = ?, p3 = ?, finding_count = ?, counts_known = ?,
              error = ?
            WHERE task_id = ?`,
          ).run(
            finishedAt,
            event.outcome,
            verdict,
            verdictReason,
            overall,
            checked,
            policy,
            provider,
            model,
            title,
            title,
            sha,
            sha,
            baseSha,
            baseSha,
            baseRef,
            baseRef,
            installationId,
            counts.p0,
            counts.p1,
            counts.p2,
            counts.p3,
            findingCount,
            countsKnown,
            errorText,
            identity.taskId,
          );
        } else {
          db.prepare(
            `INSERT INTO reviews (
              task_id, owner, repo, number, title, sha, base_sha, base_ref, installation_id,
              trigger, started_at, finished_at, outcome, verdict, verdict_reason, overall_confidence,
              checked_json, policy_json, provider, model, p0, p1, p2, p3, finding_count, counts_known, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            identity.taskId,
            identity.owner,
            identity.repo,
            identity.number,
            title,
            sha,
            baseSha,
            baseRef,
            installationId,
            finishedAt,
            finishedAt,
            event.outcome,
            verdict,
            verdictReason,
            overall,
            checked,
            policy,
            provider,
            model,
            counts.p0,
            counts.p1,
            counts.p2,
            counts.p3,
            findingCount,
            countsKnown,
            errorText,
          );
        }
        db.prepare("DELETE FROM comments WHERE task_id = ?").run(identity.taskId);
        const insert = db.prepare(
          `INSERT INTO comments (
            task_id, ordinal, path, start_line, end_line, priority, kind, category, title, body,
            trigger_text, suggestion, confidence, fingerprint, evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const comment of comments) {
          insert.run(
            identity.taskId,
            comment.ordinal,
            comment.path,
            comment.startLine,
            comment.endLine,
            comment.priority,
            comment.kind,
            comment.category,
            comment.title,
            comment.body,
            comment.trigger,
            comment.suggestion,
            comment.confidence,
            comment.fingerprint,
            JSON.stringify(comment.evidence),
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  list(filter: ReviewFilter): Promise<ReviewList> {
    return this.#exclusive(() => {
      const db = this.#database();
      const repos = db
        .prepare("SELECT DISTINCT owner, repo FROM reviews ORDER BY owner, repo")
        .all()
        .map((row) => `${str(row, "owner")}/${str(row, "repo")}`)
        .filter((repo) => repo !== "/");
      const totalRow = db.prepare("SELECT COUNT(*) AS n FROM reviews").get();
      const total = totalRow ? int(totalRow, "n") : 0;
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (filter.repo) {
        where.push("owner || '/' || repo = ?");
        params.push(filter.repo);
      }
      if (filter.since) {
        where.push("started_at >= ?");
        params.push(filter.since);
      }
      if (filter.until) {
        where.push("started_at <= ?");
        params.push(filter.until);
      }
      const resultSql = resultPredicate(filter.result);
      if (resultSql) where.push(resultSql);
      if (filter.q) {
        where.push(
          "(title LIKE ? ESCAPE '\\' OR owner || '/' || repo LIKE ? ESCAPE '\\' OR CAST(number AS TEXT) LIKE ? ESCAPE '\\')",
        );
        const like = likeContains(filter.q);
        params.push(like, like, like);
      }
      const sql = `SELECT * FROM reviews ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, rowid DESC LIMIT 500`;
      const reviews = db
        .prepare(sql)
        .all(...params)
        .map(summaryFromRow)
        .filter((row): row is ReviewSummary => row !== undefined);
      return { reviews, repos, total };
    });
  }

  /** Checkouts a review is still using. Cleanup skips these directories. */
  runningCheckouts(): Promise<Array<{ owner: string; repo: string; sha: string }>> {
    return this.#exclusive(() => {
      const rows = this.#database().prepare("SELECT owner, repo, sha FROM reviews WHERE outcome = 'running'").all();
      const keys: Array<{ owner: string; repo: string; sha: string }> = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, SQLOutputValue>;
        const owner = str(record, "owner");
        const repo = str(record, "repo");
        const sha = str(record, "sha");
        if (!owner || !repo || !sha) continue;
        keys.push({ owner, repo, sha });
      }
      return keys;
    });
  }

  exists(taskId: string): Promise<boolean> {
    if (!TASK_ID.test(taskId)) return Promise.resolve(false);
    return this.#exclusive(() => {
      const row = this.#database().prepare("SELECT 1 AS ok FROM reviews WHERE task_id = ?").get(taskId);
      return row !== undefined;
    });
  }

  get(taskId: string): Promise<ReviewDetail | null> {
    if (!TASK_ID.test(taskId)) return Promise.resolve(null);
    return this.#exclusive(() => {
      const db = this.#database();
      const row = db.prepare("SELECT * FROM reviews WHERE task_id = ?").get(taskId);
      const summary = row ? summaryFromRow(row) : undefined;
      if (!row || !summary) return null;
      const comments = db
        .prepare("SELECT * FROM comments WHERE task_id = ? ORDER BY ordinal")
        .all(taskId)
        .map(commentFromRow)
        .filter((comment): comment is StoredComment => comment !== undefined);
      return {
        ...summary,
        sha: str(row, "sha"),
        baseSha: str(row, "base_sha"),
        baseRef: str(row, "base_ref"),
        installationId: cleanInstallation(numOrNull(row, "installation_id")),
        verdictReason: str(row, "verdict_reason") || null,
        overallConfidence: cleanConfidence(numOrNull(row, "overall_confidence")),
        checked: stringList(str(row, "checked_json")),
        provider: str(row, "provider") || null,
        model: str(row, "model") || null,
        policy: parsePolicy(str(row, "policy_json")),
        comments,
        error: str(row, "error") || null,
      };
    });
  }

  async #importLegacy(): Promise<void> {
    if (!this.legacyPath) return;
    const db = this.#database();
    const count = db.prepare("SELECT COUNT(*) AS n FROM reviews").get();
    if (count && int(count, "n") > 0) return;
    const logEntries = await new ReviewLog(this.legacyPath).list();
    if (logEntries.length === 0) return;
    db.exec("BEGIN");
    try {
      const insert = db.prepare(
        `INSERT INTO reviews (
          task_id, owner, repo, number, title, sha, base_sha, base_ref, installation_id,
          trigger, started_at, finished_at, outcome, verdict, verdict_reason, overall_confidence,
          checked_json, policy_json, provider, model, p0, p1, p2, p3, finding_count, counts_known
        ) VALUES (?, ?, ?, ?, '', '', '', '', NULL, ?, ?, ?, ?, ?, NULL, NULL, '[]', NULL, NULL, NULL, 0, 0, 0, 0, ?, 0)`,
      );
      for (const entry of logEntries) {
        insert.run(
          entry.taskId,
          entry.owner,
          entry.repo,
          entry.number,
          entry.trigger,
          entry.startedAt,
          entry.finishedAt,
          entry.outcome,
          entry.verdict,
          entry.findingCount,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      log("error", "could not import review log", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  #exclusive<T>(fn: () => T): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #database(): DatabaseSync {
    if (!this.#db) throw new Error("Review archive is closed.");
    return this.#db;
  }
}

/** Green pass, yellow suggestions, red P0/P1, gray error. Running stays separate. */
export function reviewResult(row: Pick<ReviewSummary, "outcome" | "verdict" | "p0" | "p1" | "p2" | "p3" | "findingCount" | "countsKnown">): ReviewResultKind {
  if (row.outcome === "failed") return "error";
  if (row.outcome !== "completed") return "running";
  if (row.p0 > 0 || row.p1 > 0) return "blocker";
  const known = row.p0 + row.p1 + row.p2 + row.p3;
  const legacy = row.countsKnown ? 0 : Math.max(0, row.findingCount ?? 0);
  if (known > 0 || legacy > 0 || row.verdict === "fix_recommended" || row.verdict === "block") return "suggest";
  return "pass";
}

function resultPredicate(result: ReviewFilter["result"]): string | undefined {
  if (result === "error") return "outcome = 'failed'";
  if (result === "running") return "outcome = 'running'";
  if (result === "blocker") return "outcome = 'completed' AND (p0 > 0 OR p1 > 0)";
  if (result === "suggest") {
    return `outcome = 'completed' AND p0 = 0 AND p1 = 0 AND (
      p2 > 0 OR p3 > 0 OR verdict = 'fix_recommended' OR verdict = 'block'
      OR (counts_known = 0 AND COALESCE(finding_count, 0) > 0)
    )`;
  }
  if (result === "pass") {
    return `outcome = 'completed' AND p0 = 0 AND p1 = 0 AND p2 = 0 AND p3 = 0
      AND COALESCE(verdict, 'clean') = 'clean'
      AND (counts_known = 1 OR COALESCE(finding_count, 0) = 0)`;
  }
  return undefined;
}

/** Existing archives created before the error column keep their rows. */
function migrateReviews(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(reviews)").all();
  const names = new Set(columns.map((row) => str(row, "name")));
  if (!names.has("error")) db.exec("ALTER TABLE reviews ADD COLUMN error TEXT");
}

function cleanError(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = clip(value, 2000).trim();
  return text.length > 0 ? text : null;
}

function summaryFromRow(row: Record<string, SQLOutputValue>): ReviewSummary | undefined {
  const identity = cleanIdentity({
    taskId: str(row, "task_id"),
    owner: str(row, "owner"),
    repo: str(row, "repo"),
    number: int(row, "number"),
  });
  if (!identity) return undefined;
  const outcome = str(row, "outcome");
  if (outcome !== "running" && outcome !== "completed" && outcome !== "failed") return undefined;
  const trigger = str(row, "trigger");
  if (!TRIGGERS.has(trigger)) return undefined;
  const startedAt = str(row, "started_at");
  if (!isIso(startedAt)) return undefined;
  const finishedRaw = row.finished_at;
  const finishedAt = typeof finishedRaw === "string" && isIso(finishedRaw) ? finishedRaw : null;
  return {
    ...identity,
    title: str(row, "title"),
    trigger,
    startedAt,
    finishedAt,
    outcome,
    verdict: cleanVerdict(str(row, "verdict") || null),
    p0: int(row, "p0"),
    p1: int(row, "p1"),
    p2: int(row, "p2"),
    p3: int(row, "p3"),
    findingCount: numOrNull(row, "finding_count"),
    countsKnown: int(row, "counts_known") !== 0,
  };
}

function commentFromRow(row: Record<string, SQLOutputValue>): StoredComment | undefined {
  const priority = int(row, "priority");
  if (priority !== 0 && priority !== 1 && priority !== 2 && priority !== 3) return undefined;
  const path = str(row, "path");
  if (!path) return undefined;
  return {
    ordinal: int(row, "ordinal"),
    path,
    startLine: int(row, "start_line"),
    endLine: int(row, "end_line"),
    priority,
    kind: str(row, "kind"),
    category: str(row, "category"),
    title: str(row, "title"),
    body: str(row, "body"),
    trigger: str(row, "trigger_text"),
    suggestion: str(row, "suggestion") || null,
    confidence: cleanConfidence(numOrNull(row, "confidence")) ?? 0,
    fingerprint: str(row, "fingerprint"),
    evidence: stringList(str(row, "evidence_json")),
  };
}

function cleanComments(findings: Finding[] | undefined): StoredComment[] {
  if (!findings) return [];
  const comments: StoredComment[] = [];
  for (const finding of findings.slice(0, MAX_FINDINGS)) {
    let path: string;
    try {
      path = normalizeRepoPath(finding.path);
    } catch {
      continue;
    }
    if (!Number.isInteger(finding.startLine) || finding.startLine < 1) continue;
    if (!Number.isInteger(finding.endLine) || finding.endLine < finding.startLine) continue;
    if (finding.priority !== 0 && finding.priority !== 1 && finding.priority !== 2 && finding.priority !== 3) continue;
    const title = clip(finding.title, 80);
    if (!title) continue;
    const fingerprint = FINGERPRINT.test(finding.fingerprint)
      ? finding.fingerprint
      : findingFingerprint({ path, category: finding.category, title });
    comments.push({
      ordinal: comments.length,
      path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      priority: finding.priority,
      kind: clip(finding.kind, 40),
      category: clip(finding.category, 40),
      title,
      body: clip(finding.body, 8_000),
      trigger: clip(finding.trigger, 2_000),
      suggestion: finding.suggestion ? clip(finding.suggestion, 8_000) : null,
      confidence: cleanConfidence(finding.confidence) ?? 0,
      fingerprint,
      evidence: (finding.evidence ?? []).slice(0, 10).map((item) => clip(item, 200)).filter((item) => item.length > 0),
    });
  }
  return comments;
}

function countPriorities(comments: StoredComment[]): { p0: number; p1: number; p2: number; p3: number } {
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 };
  for (const comment of comments) counts[`p${comment.priority}`] += 1;
  return counts;
}

function policyJson(policy: ReviewPolicy | null | undefined): string | null {
  if (!policy) return null;
  const stored: StoredPolicy = {
    profile: policy.profile,
    trigger: policy.trigger,
    drafts: policy.drafts,
    language: policy.language,
    summary: policy.summary,
    minConfidence: policy.minConfidence,
    minInlinePriority: policy.minInlinePriority,
    p2InlineMinConfidence: policy.p2InlineMinConfidence,
    maxInline: policy.maxInline,
  };
  return JSON.stringify(stored);
}

function parsePolicy(value: string): StoredPolicy | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.trigger !== "string" || typeof parsed.profile !== "string") return null;
    return {
      profile: clip(parsed.profile, 40),
      trigger: clip(parsed.trigger, 40),
      drafts: parsed.drafts === true,
      language: typeof parsed.language === "string" ? clip(parsed.language, 16) : "en",
      summary: parsed.summary === true,
      minConfidence: typeof parsed.minConfidence === "number" ? parsed.minConfidence : 0,
      minInlinePriority: typeof parsed.minInlinePriority === "number" ? parsed.minInlinePriority : 0,
      p2InlineMinConfidence: typeof parsed.p2InlineMinConfidence === "number" ? parsed.p2InlineMinConfidence : 0,
      maxInline: typeof parsed.maxInline === "number" ? parsed.maxInline : 0,
    };
  } catch {
    return null;
  }
}

function cleanIdentity(input: { taskId: string; owner: string; repo: string; number: number }): Identity | undefined {
  if (typeof input.taskId !== "string" || !TASK_ID.test(input.taskId)) return undefined;
  if (typeof input.owner !== "string" || !NAME.test(input.owner) || input.owner.length > 100) return undefined;
  if (typeof input.repo !== "string" || !NAME.test(input.repo) || input.repo.length > 100) return undefined;
  if (!Number.isInteger(input.number) || input.number < 1 || input.number > 1_000_000_000) return undefined;
  return { taskId: input.taskId, owner: input.owner, repo: input.repo, number: input.number };
}

function cleanVerdict(value: string | null): ReviewSummary["verdict"] {
  if (value === "block" || value === "fix_recommended" || value === "clean") return value;
  return null;
}

function cleanCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 10_000) return null;
  return value;
}

function cleanInstallation(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) return null;
  return value;
}

function cleanConfidence(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function cleanChecked(value: string[] | undefined): string[] {
  if (!value) return [];
  return value.slice(0, 6).map((item) => clip(item, 200)).filter((item) => item.length > 0);
}

function stringList(value: string): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string").slice(0, 10);
  } catch {
    return [];
  }
}

function likeContains(value: string): string {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function clip(value: string, max: number): string {
  return value.replaceAll("\0", "").slice(0, max);
}

function str(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function int(row: Record<string, SQLOutputValue>, key: string): number {
  const value = numOrNull(row, key);
  return value ?? 0;
}

function numOrNull(row: Record<string, SQLOutputValue>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function isIso(value: string): boolean {
  return value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
