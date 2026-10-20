import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { isThinkingLevel } from "../config.js";
import { log } from "../log.js";
import type { PullFile } from "../github/client.js";
import { fileFacts, isSkipReason, type RecordedFinding } from "./findings.js";
import type { ReviewFinished } from "./history.js";
import { ReviewLog } from "./history.js";
import type { ReviewPolicy } from "./policy.js";
import {
  findingFingerprint,
  normalizeRepoPath,
  resolveFindingClassification,
  type Finding,
  type Priority,
} from "./schema.js";
import { queryReviewStats, type StatsQuery, type StatsSnapshot } from "./stats.js";
import type { ReviewRequest } from "../types.js";
import type { ReviewUsage } from "./usage.js";

/** SQLite file in the data directory. Mode 0600. Finished reviews also store their pull file list. */
export const REVIEWS_DB_FILE = "reviews.sqlite";

const NAME = /^[A-Za-z0-9_.-]+$/;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;
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
  /** Absent on rows recorded before informational flags could be posted. Treated as false. */
  postInformational?: boolean;
};

export type StoredComment = {
  ordinal: number;
  path: string;
  startLine: number;
  endLine: number;
  priority: Priority;
  kind: string;
  /** Null on comments stored before finding types existed. */
  findingType: string | null;
  subtype: string | null;
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
  provider: string | null;
  model: string | null;
  /** Thinking level this review actually used. Null for rows recorded before that column existed. */
  thinking: string | null;
};

export type ReviewDetail = ReviewSummary & {
  sha: string;
  baseSha: string;
  baseRef: string;
  installationId: number | null;
  verdictReason: string | null;
  overallConfidence: number | null;
  checked: string[];
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

type PullMissingClose = {
  owner: string;
  repo: string;
  number: number;
  installationId: number | null;
};

type Identity = { taskId: string; owner: string; repo: string; number: number };

/**
 * Review metadata, structured comments, and the file list of a finished review.
 * That list is the diff at the review's head SHA, not a later pull request head.
 * A running review is not stored here: the pull request can still move.
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
        error TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        reasoning_tokens INTEGER,
        model_calls INTEGER,
        cost_usd REAL,
        thinking TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS comments (
        task_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        kind TEXT NOT NULL,
        finding_type TEXT,
        subtype TEXT,
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
      CREATE TABLE IF NOT EXISTS findings (
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
        finding_type TEXT,
        subtype TEXT,
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
        created_at TEXT NOT NULL,
        adoption TEXT,
        adoption_head TEXT,
        adoption_at TEXT,
        FOREIGN KEY (task_id) REFERENCES reviews(task_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS reviews_started ON reviews(started_at DESC);
      CREATE INDEX IF NOT EXISTS reviews_repo_started ON reviews(owner, repo, started_at);
      CREATE INDEX IF NOT EXISTS findings_task ON findings(task_id);
      CREATE INDEX IF NOT EXISTS findings_repo ON findings(owner, repo, number);
      CREATE INDEX IF NOT EXISTS findings_category ON findings(category, priority);
      CREATE TABLE IF NOT EXISTS pull_closes (
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        title TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        installation_id INTEGER,
        draft INTEGER NOT NULL,
        merged INTEGER NOT NULL,
        closed_at TEXT NOT NULL,
        classify_attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner, repo, number)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS findings_fingerprint ON findings(fingerprint);
      CREATE INDEX IF NOT EXISTS findings_created ON findings(created_at);
      CREATE INDEX IF NOT EXISTS findings_language ON findings(language);
      CREATE INDEX IF NOT EXISTS findings_path ON findings(path);
      CREATE TABLE IF NOT EXISTS pull_snapshots (
        task_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        files_json TEXT NOT NULL,
        PRIMARY KEY (task_id, sha),
        FOREIGN KEY (task_id) REFERENCES reviews(task_id) ON DELETE CASCADE
      ) STRICT;
    `);
    migrateReviews(db);
    migrateFindingColumns(db);
    migratePullCloses(db);
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
    const recorded = cleanRecorded(
      event.recordedFindings ??
        (!failed && event.findings
          ? event.findings.map((finding) => ({ finding, posted: null, skipReason: null }))
          : undefined),
    );
    const counts = recorded.length > 0 ? countRecorded(recorded) : countPriorities(comments);
    const findingCount =
      recorded.length > 0
        ? recorded.length
        : failed
          ? null
          : comments.length > 0
            ? comments.length
            : cleanCount(event.findingCount);
    const countsKnown = recorded.length > 0 ? 1 : failed ? 1 : event.findings ? 1 : 0;
    const usage = cleanUsage(event.usage);
    const verdictReason = failed ? null : clip(event.verdictReason ?? "", 300) || null;
    const overall = failed ? null : cleanConfidence(event.overallConfidence);
    const checked = JSON.stringify(cleanChecked(event.checked));
    const policy = policyJson(event.policy);
    const provider = clip(event.provider ?? "", 80) || null;
    const model = clip(event.modelId ?? "", 80) || null;
    const thinking = cleanThinking(event.thinking);
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
              provider = COALESCE(?, provider), model = COALESCE(?, model), thinking = COALESCE(?, thinking),
              title = CASE WHEN ? != '' THEN ? ELSE title END,
              sha = CASE WHEN ? != '' THEN ? ELSE sha END,
              base_sha = CASE WHEN ? != '' THEN ? ELSE base_sha END,
              base_ref = CASE WHEN ? != '' THEN ? ELSE base_ref END,
              installation_id = COALESCE(?, installation_id),
              p0 = ?, p1 = ?, p2 = ?, p3 = ?, finding_count = ?, counts_known = ?,
              error = ?,
              input_tokens = CASE WHEN ? = 1 THEN ? ELSE input_tokens END,
              output_tokens = CASE WHEN ? = 1 THEN ? ELSE output_tokens END,
              cache_read_tokens = CASE WHEN ? = 1 THEN ? ELSE cache_read_tokens END,
              reasoning_tokens = CASE WHEN ? = 1 THEN ? ELSE reasoning_tokens END,
              model_calls = CASE WHEN ? = 1 THEN ? ELSE model_calls END,
              cost_usd = CASE WHEN ? = 1 THEN ? ELSE cost_usd END
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
            thinking,
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
            ...usageParams(usage),
            identity.taskId,
          );
        } else {
          db.prepare(
            `INSERT INTO reviews (
              task_id, owner, repo, number, title, sha, base_sha, base_ref, installation_id,
              trigger, started_at, finished_at, outcome, verdict, verdict_reason, overall_confidence,
              checked_json, policy_json, provider, model, thinking, p0, p1, p2, p3, finding_count, counts_known, error,
              input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, model_calls, cost_usd
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            thinking,
            counts.p0,
            counts.p1,
            counts.p2,
            counts.p3,
            findingCount,
            countsKnown,
            errorText,
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheReadTokens,
            usage.reasoningTokens,
            usage.modelCalls,
            usage.costUsd,
          );
        }
        db.prepare("DELETE FROM comments WHERE task_id = ?").run(identity.taskId);
        const insert = db.prepare(
          `INSERT INTO comments (
            task_id, ordinal, path, start_line, end_line, priority, kind, finding_type, subtype, category, title, body,
            trigger_text, suggestion, confidence, fingerprint, evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            comment.findingType,
            comment.subtype,
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
        const storedSha = sha || str(existing ?? {}, "sha");
        db.prepare("DELETE FROM findings WHERE task_id = ?").run(identity.taskId);
        const insertFinding = db.prepare(
          `INSERT INTO findings (
            task_id, owner, repo, number, sha, title, body, trigger_text, priority, kind, finding_type, subtype, category,
            cwe, rule_ref, confidence, path, start_line, end_line, extension, language, fingerprint,
            posted, skip_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const row of recorded) {
          const facts = fileFacts(row.path);
          insertFinding.run(
            identity.taskId,
            identity.owner,
            identity.repo,
            identity.number,
            storedSha,
            row.title,
            row.body,
            row.trigger,
            row.priority,
            row.kind,
            row.findingType,
            row.subtype,
            row.category,
            row.cwe,
            row.ruleRef,
            row.confidence,
            row.path,
            row.startLine,
            row.endLine,
            facts.extension,
            facts.language,
            row.fingerprint,
            row.posted === null ? null : row.posted ? 1 : 0,
            row.skipReason,
            finishedAt,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /**
   * Posted inline comments on this pull request that do not yet have an adoption outcome.
   * Summary-only mentions (a skip reason) stay out of the adoption denominator.
   */
  unclassifiedPosts(owner: string, repo: string, number: number): Promise<PostedFinding[]> {
    if (!NAME.test(owner) || !NAME.test(repo) || !Number.isInteger(number) || number < 1) return Promise.resolve([]);
    return this.#exclusive(() => {
      const rows = this.#database()
        .prepare(
          `SELECT id, task_id, sha, path, start_line, end_line, fingerprint
           FROM findings
           WHERE owner = ? AND repo = ? AND number = ?
             AND posted = 1 AND skip_reason IS NULL AND adoption IS NULL
           ORDER BY id`,
        )
        .all(owner, repo, number);
      const findings: PostedFinding[] = [];
      for (const row of rows) {
        const id = int(row, "id");
        const taskId = str(row, "task_id");
        const path = str(row, "path");
        const fingerprint = str(row, "fingerprint");
        const sha = str(row, "sha");
        if (id < 1 || !taskId || !path || !fingerprint || !sha) continue;
        findings.push({
          id,
          taskId,
          sha,
          path,
          fingerprint,
          startLine: int(row, "start_line"),
          endLine: int(row, "end_line"),
        });
      }
      return findings;
    });
  }

  /**
   * Write adoption once. A second call does not change a row that already has an outcome.
   * Returns how many rows changed.
   */
  recordAdoption(rows: readonly AdoptionWrite[]): Promise<number> {
    if (rows.length === 0) return Promise.resolve(0);
    const at = new Date().toISOString();
    return this.#exclusive(() => {
      const db = this.#database();
      const update = db.prepare(
        `UPDATE findings
         SET adoption = ?, adoption_head = ?, adoption_at = ?
         WHERE id = ? AND adoption IS NULL AND posted = 1 AND skip_reason IS NULL`,
      );
      let changed = 0;
      db.exec("BEGIN");
      try {
        for (const row of rows) {
          if (row.adoption !== "adopted" && row.adoption !== "ignored") continue;
          if (!Number.isInteger(row.id) || row.id < 1) continue;
          const head = row.head.trim().toLowerCase();
          if (!/^[0-9a-f]{7,64}$/.test(head)) continue;
          changed += Number(update.run(row.adoption, head, at, row.id).changes);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return changed;
    });
  }

  /**
   * Remember a closed pull request so a review that archives later can still be classified.
   * A later close replaces the head SHA. Already-written adoption outcomes stay put.
   * `current` runs in the archive lock, before the insert. A lifecycle webhook bumps its epoch
   * before queueing on that lock, so this write cannot restore a close the webhook already dropped.
   */
  rememberClosedPull(request: ReviewRequest, merged: boolean, current?: () => boolean): Promise<boolean> {
    if (!NAME.test(request.owner) || !NAME.test(request.repo)) return Promise.resolve(false);
    if (!Number.isInteger(request.number) || request.number < 1) return Promise.resolve(false);
    const sha = request.sha.trim().toLowerCase();
    const baseSha = request.baseSha.trim().toLowerCase();
    if (!COMMIT_SHA.test(sha) || !COMMIT_SHA.test(baseSha)) return Promise.resolve(false);
    const cloneUrl = request.cloneUrl.trim();
    if (!cloneUrl.startsWith("https://") || cloneUrl.length > 500) return Promise.resolve(false);
    const installationId = cleanInstallation(request.installationId);
    const closedAt = new Date().toISOString();
    return this.#exclusive(() => {
      if (current && !current()) return false;
      this.#database()
        .prepare(
          `INSERT INTO pull_closes (
            owner, repo, number, sha, base_sha, base_ref, title, clone_url, installation_id, draft, merged, closed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner, repo, number) DO UPDATE SET
            sha = excluded.sha,
            base_sha = excluded.base_sha,
            base_ref = excluded.base_ref,
            title = excluded.title,
            clone_url = excluded.clone_url,
            installation_id = excluded.installation_id,
            draft = excluded.draft,
            merged = excluded.merged,
            closed_at = excluded.closed_at`,
        )
        .run(
          request.owner,
          request.repo,
          request.number,
          sha,
          baseSha,
          clip(request.baseRef, 200),
          clip(request.title, 300),
          cloneUrl,
          installationId,
          request.draft ? 1 : 0,
          merged ? 1 : 0,
          closedAt,
        );
      return true;
    });
  }

  /** Drop a stored close. A reopened pull request is not classified against that head. */
  forgetClosedPull(owner: string, repo: string, number: number): Promise<void> {
    if (!NAME.test(owner) || !NAME.test(repo) || !Number.isInteger(number) || number < 1) return Promise.resolve();
    return this.#exclusive(() => {
      this.#database().prepare("DELETE FROM pull_closes WHERE owner = ? AND repo = ? AND number = ?").run(owner, repo, number);
    });
  }

  /** The latest close for this pull request, or null when it is still open or was never seen. */
  closedPull(owner: string, repo: string, number: number): Promise<{ request: ReviewRequest; merged: boolean } | null> {
    if (!NAME.test(owner) || !NAME.test(repo) || !Number.isInteger(number) || number < 1) return Promise.resolve(null);
    return this.#exclusive(() => {
      const row = this.#database()
        .prepare(`${CLOSED_PULL_COLUMNS} FROM pull_closes WHERE owner = ? AND repo = ? AND number = ?`)
        .get(owner, repo, number);
      return row ? closedPullFromRow(row) : null;
    });
  }

  /**
   * Stored closes that still have a posted comment with no adoption outcome.
   * `maxAttempts` stops a close GitHub can never classify from being retried forever.
   */
  closesAwaitingAdoption(maxAttempts: number): Promise<Array<{ request: ReviewRequest; merged: boolean }>> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return Promise.resolve([]);
    return this.#exclusive(() => {
      const rows = this.#database()
        .prepare(
          `${CLOSED_PULL_COLUMNS}
           FROM pull_closes
           WHERE classify_attempts < ?
             AND EXISTS (
               SELECT 1 FROM findings
               WHERE findings.owner = pull_closes.owner
                 AND findings.repo = pull_closes.repo
                 AND findings.number = pull_closes.number
                 AND findings.posted = 1
                 AND findings.skip_reason IS NULL
                 AND findings.adoption IS NULL
             )
           ORDER BY closed_at`,
        )
        .all(maxAttempts);
      const closes: Array<{ request: ReviewRequest; merged: boolean }> = [];
      for (const row of rows) {
        const closed = closedPullFromRow(row);
        if (closed) closes.push(closed);
      }
      return closes;
    });
  }

  /** Count one failed classification. A reopened pull request drops the row, so the next close starts over. */
  noteCloseAttempt(owner: string, repo: string, number: number): Promise<void> {
    if (!NAME.test(owner) || !NAME.test(repo) || !Number.isInteger(number) || number < 1) return Promise.resolve();
    return this.#exclusive(() => {
      this.#database()
        .prepare(
          "UPDATE pull_closes SET classify_attempts = classify_attempts + 1 WHERE owner = ? AND repo = ? AND number = ?",
        )
        .run(owner, repo, number);
    });
  }

  /**
   * Posted comments that have no adoption outcome and no stored close.
   * Oldest finding first, so a backlog is reconciled before newer open pulls.
   */
  pullsMissingClose(): Promise<PullMissingClose[]> {
    return this.#exclusive(() => {
      const rows = this.#database()
        .prepare(
          `SELECT f.owner AS owner, f.repo AS repo, f.number AS number,
                  (
                    SELECT r.installation_id
                    FROM reviews r
                    WHERE r.owner = f.owner AND r.repo = f.repo AND r.number = f.number
                      AND r.installation_id IS NOT NULL
                    ORDER BY r.started_at DESC
                    LIMIT 1
                  ) AS installation_id
           FROM findings f
           WHERE f.posted = 1
             AND f.skip_reason IS NULL
             AND f.adoption IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM pull_closes c
               WHERE c.owner = f.owner AND c.repo = f.repo AND c.number = f.number
             )
           GROUP BY f.owner, f.repo, f.number
           ORDER BY MIN(f.id)`,
        )
        .all();
      const pulls: PullMissingClose[] = [];
      for (const row of rows) {
        const owner = str(row, "owner");
        const repo = str(row, "repo");
        const number = int(row, "number");
        if (!NAME.test(owner) || !NAME.test(repo) || number < 1) continue;
        pulls.push({
          owner,
          repo,
          number,
          installationId: cleanInstallation(numOrNull(row, "installation_id")),
        });
      }
      return pulls;
    });
  }

  /** Aggregated counts for the statistics page. Finding text stays in the database. */
  stats(filter: StatsQuery): Promise<StatsSnapshot> {
    return this.#exclusive(() => queryReviewStats(this.#database(), filter));
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
        policy: parsePolicy(str(row, "policy_json")),
        comments,
        error: str(row, "error") || null,
      };
    });
  }

  /**
   * File list captured for a finished review at `sha`.
   * Null when nothing is stored or the stored JSON is not a file list.
   */
  readPullSnapshot(taskId: string, sha: string): Promise<PullFile[] | null> {
    if (!TASK_ID.test(taskId) || sha.length === 0) return Promise.resolve(null);
    return this.#exclusive(() => {
      const row = this.#database()
        .prepare("SELECT files_json FROM pull_snapshots WHERE task_id = ? AND sha = ?")
        .get(taskId, sha);
      if (!row) return null;
      const files = parseStoredPullFiles(str(row, "files_json"));
      if (files) return files;
      log("error", "ignored unreadable pull snapshot", { taskId });
      return null;
    });
  }

  /** Replace any older snapshot for this task. The key is the review's head SHA. */
  writePullSnapshot(taskId: string, sha: string, files: PullFile[]): Promise<void> {
    if (!TASK_ID.test(taskId) || sha.length === 0) return Promise.resolve();
    const payload = JSON.stringify(files.map(storedPullFile));
    return this.#exclusive(() => {
      const db = this.#database();
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM pull_snapshots WHERE task_id = ? AND sha != ?").run(taskId, sha);
        db.prepare(
          `INSERT INTO pull_snapshots (task_id, sha, files_json) VALUES (?, ?, ?)
           ON CONFLICT(task_id, sha) DO UPDATE SET files_json = excluded.files_json`,
        ).run(taskId, sha, payload);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
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

export type PostedFinding = {
  id: number;
  taskId: string;
  sha: string;
  path: string;
  startLine: number;
  endLine: number;
  fingerprint: string;
};

export type AdoptionWrite = {
  id: number;
  adoption: "adopted" | "ignored";
  head: string;
};

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

/**
 * Additive columns only, in the order they shipped: `error`, then the usage
 * columns, then `thinking`. Existing rows keep NULL usage, which the statistics
 * page shows as unknown rather than zero. A missing findings table is created on open.
 */
function migrateReviews(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(reviews)").all();
  const names = new Set(columns.map((row) => str(row, "name")));
  const add = (name: string, ddl: string) => {
    if (!names.has(name)) db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`);
  };
  add("error", "error TEXT");
  add("input_tokens", "input_tokens INTEGER");
  add("output_tokens", "output_tokens INTEGER");
  add("cache_read_tokens", "cache_read_tokens INTEGER");
  add("reasoning_tokens", "reasoning_tokens INTEGER");
  add("model_calls", "model_calls INTEGER");
  add("cost_usd", "cost_usd REAL");
  add("thinking", "thinking TEXT");
}

/** Nullable type columns. Rows written before the column existed stay null. */
function migrateFindingColumns(db: DatabaseSync): void {
  const present = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => str(row, "name")),
  );
  const add = (table: "findings" | "comments") => {
    if (!present.has(table)) return;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const names = new Set(columns.map((row) => str(row, "name")));
    if (!names.has("finding_type")) db.exec(`ALTER TABLE ${table} ADD COLUMN finding_type TEXT`);
    if (!names.has("subtype")) db.exec(`ALTER TABLE ${table} ADD COLUMN subtype TEXT`);
    if (table === "findings") {
      if (!names.has("adoption")) db.exec(`ALTER TABLE findings ADD COLUMN adoption TEXT`);
      if (!names.has("adoption_head")) db.exec(`ALTER TABLE findings ADD COLUMN adoption_head TEXT`);
      if (!names.has("adoption_at")) db.exec(`ALTER TABLE findings ADD COLUMN adoption_at TEXT`);
    }
  };
  add("findings");
  add("comments");
}

/** A close written before retries existed has no attempt count. New rows start at zero. */
function migratePullCloses(db: DatabaseSync): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_closes'").get();
  if (!table) return;
  const names = new Set(db.prepare("PRAGMA table_info(pull_closes)").all().map((row) => str(row, "name")));
  if (!names.has("classify_attempts")) {
    db.exec("ALTER TABLE pull_closes ADD COLUMN classify_attempts INTEGER NOT NULL DEFAULT 0");
  }
}

const CLOSED_PULL_COLUMNS =
  "SELECT owner, repo, number, sha, base_sha, base_ref, title, clone_url, installation_id, draft, merged";

function closedPullFromRow(row: Record<string, SQLOutputValue>): { request: ReviewRequest; merged: boolean } | null {
  const owner = str(row, "owner");
  const repo = str(row, "repo");
  const number = int(row, "number");
  if (!NAME.test(owner) || !NAME.test(repo) || number < 1) return null;
  const sha = str(row, "sha");
  const baseSha = str(row, "base_sha");
  const cloneUrl = str(row, "clone_url");
  if (!COMMIT_SHA.test(sha) || !COMMIT_SHA.test(baseSha) || !cloneUrl.startsWith("https://")) return null;
  const installation = row.installation_id;
  return {
    merged: int(row, "merged") === 1,
    request: {
      owner,
      repo,
      number,
      sha,
      baseSha,
      baseRef: str(row, "base_ref"),
      title: str(row, "title"),
      cloneUrl,
      installationId: typeof installation === "number" ? cleanInstallation(installation) : null,
      draft: int(row, "draft") === 1,
    },
  };
}

function cleanThinking(value: string | undefined): string | null {
  if (typeof value !== "string" || !isThinkingLevel(value)) return null;
  return value;
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
    provider: str(row, "provider") || null,
    model: str(row, "model") || null,
    thinking: cleanThinking(str(row, "thinking")),
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
    findingType: optionalText(str(row, "finding_type")),
    subtype: optionalText(str(row, "subtype")),
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
    const classification = classificationOf(finding);
    comments.push({
      ordinal: comments.length,
      path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      priority: finding.priority,
      kind: classification.kind,
      findingType: classification.type,
      subtype: classification.subtype,
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

type FindingRow = {
  path: string;
  startLine: number;
  endLine: number;
  priority: Priority;
  kind: string;
  findingType: string | null;
  subtype: string | null;
  category: string;
  title: string;
  body: string;
  trigger: string;
  confidence: number;
  fingerprint: string;
  cwe: string | null;
  ruleRef: string | null;
  posted: boolean | null;
  skipReason: string | null;
};

function cleanRecorded(findings: RecordedFinding[] | undefined): FindingRow[] {
  if (!findings) return [];
  const rows: FindingRow[] = [];
  const seen = new Set<string>();
  for (const item of findings) {
    if (rows.length >= MAX_FINDINGS) break;
    const finding = item.finding;
    let path: string;
    try {
      path = normalizeRepoPath(finding.path);
    } catch {
      path = clip(finding.path.replaceAll("\0", ""), 500);
      if (!path) continue;
    }
    if (!Number.isInteger(finding.startLine) || finding.startLine < 1) continue;
    if (!Number.isInteger(finding.endLine) || finding.endLine < finding.startLine) continue;
    if (finding.priority !== 0 && finding.priority !== 1 && finding.priority !== 2 && finding.priority !== 3) continue;
    const title = clip(finding.title, 80);
    if (!title) continue;
    const fingerprint = FINGERPRINT.test(finding.fingerprint)
      ? finding.fingerprint
      : findingFingerprint({ path, category: finding.category || "unknown", title });
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const category = clip(finding.category, 40) || "unknown";
    const classification = classificationOf(finding);
    rows.push({
      path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      priority: finding.priority,
      kind: classification.kind,
      findingType: classification.type,
      subtype: classification.subtype,
      category,
      title,
      body: clip(finding.body, 8_000),
      trigger: clip(finding.trigger, 2_000),
      confidence: cleanConfidence(finding.confidence) ?? 0,
      fingerprint,
      cwe: finding.cwe ? clip(finding.cwe, 40) : null,
      ruleRef: finding.ruleRef ? clip(finding.ruleRef, 200) : null,
      posted: item.posted === true ? true : item.posted === false ? false : null,
      skipReason: isSkipReason(item.skipReason) ? item.skipReason : null,
    });
  }
  return rows;
}

function countRecorded(rows: FindingRow[]): { p0: number; p1: number; p2: number; p3: number } {
  const counts = { p0: 0, p1: 0, p2: 0, p3: 0 };
  for (const row of rows) counts[`p${row.priority}`] += 1;
  return counts;
}

type CleanUsage = {
  known: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  reasoningTokens: number | null;
  modelCalls: number | null;
  costUsd: number | null;
};

function cleanUsage(usage: ReviewUsage | undefined): CleanUsage {
  if (!usage) {
    return {
      known: false,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      reasoningTokens: null,
      modelCalls: null,
      costUsd: null,
    };
  }
  return {
    known: true,
    inputTokens: countOrZero(usage.inputTokens),
    outputTokens: countOrZero(usage.outputTokens),
    cacheReadTokens: countOrNull(usage.cacheReadTokens),
    reasoningTokens: countOrNull(usage.reasoningTokens),
    modelCalls: countOrZero(usage.modelCalls),
    costUsd: costOrNull(usage.costUsd),
  };
}

function usageParams(usage: CleanUsage): SQLInputValue[] {
  const flag = usage.known ? 1 : 0;
  return [
    flag,
    usage.inputTokens,
    flag,
    usage.outputTokens,
    flag,
    usage.cacheReadTokens,
    flag,
    usage.reasoningTokens,
    flag,
    usage.modelCalls,
    flag,
    usage.costUsd,
  ];
}

function countOrZero(value: number | null | undefined): number {
  return countOrNull(value) ?? 0;
}

function countOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), 1_000_000_000_000);
}

function costOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
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
    postInformational: policy.postInformational,
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
      postInformational: parsed.postInformational === true,
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

function classificationOf(finding: Finding): { kind: string; type: string; subtype: string } {
  return resolveFindingClassification({
    kind: finding.kind,
    priority: finding.priority,
    type: finding.type,
    subtype: finding.subtype,
  });
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

const MAX_SNAPSHOT_FILES = 3_000;

function storedPullFile(file: PullFile): PullFile {
  return {
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
    previousFilename: file.previousFilename,
  };
}

function parseStoredPullFiles(json: string): PullFile[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SNAPSHOT_FILES) return null;
  const files: PullFile[] = [];
  for (const row of parsed) {
    const file = parseStoredPullFile(row);
    if (!file) return null;
    files.push(file);
  }
  return files;
}

function parseStoredPullFile(row: unknown): PullFile | null {
  if (!isRecord(row)) return null;
  const filename = repoPath(row.filename);
  const previous = optionalRepoPath(row.previousFilename);
  const status = typeof row.status === "string" && row.status.length > 0 && row.status.length <= 40 ? row.status : null;
  if (!filename || !previous || !status) return null;
  const additions = countField(row.additions);
  const deletions = countField(row.deletions);
  const patch = row.patch === null ? null : typeof row.patch === "string" ? row.patch : undefined;
  if (additions === null || deletions === null || patch === undefined) return null;
  return { filename, status, additions, deletions, patch, previousFilename: previous.path };
}

function optionalRepoPath(value: unknown): { path: string | null } | null {
  if (value === null) return { path: null };
  const path = repoPath(value);
  if (!path) return null;
  return { path };
}

function countField(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/** Reject absolute paths and `..` so a corrupt snapshot cannot point outside the repo. */
function repoPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) return null;
  const filename = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!filename || filename.startsWith("/") || filename.split("/").includes("..")) return null;
  return filename;
}
