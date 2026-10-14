import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

/** Server-side statistics filter. `since` is an inclusive ISO timestamp. Null means all time. */
export type StatsQuery = {
  repo: string;
  since: string | null;
  /** Minutes east of UTC. Daily buckets use this offset so the chart matches browser local days. */
  tzOffsetMinutes: number;
};

export type StatsSnapshot = {
  reviews: number;
  completed: number;
  failed: number;
  running: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  durationSamples: number;
  failures: Array<{ reason: string; count: number }>;
  priorities: { p0: number; p1: number; p2: number; p3: number; unknownReviews: number };
  categories: Array<{ category: string; count: number }>;
  verdicts: { block: number; fixRecommended: number; clean: number; unknown: number };
  trend: Array<{
    day: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    reviews: number;
  }>;
  tokens: {
    knownReviews: number;
    unknownReviews: number;
    avgInput: number | null;
    avgOutput: number | null;
    avgTotal: number | null;
    totalInput: number;
    totalOutput: number;
    /** Null when no known review reported cache-read tokens. */
    totalCacheRead: number | null;
    /** Null when no known review reported reasoning tokens. */
    totalReasoning: number | null;
    /** Null when no known review reported a cost. */
    totalCostUsd: number | null;
    costKnownReviews: number;
  };
  expensive: Array<{
    repo: string;
    number: number;
    title: string;
    reviews: number;
    totalTokens: number;
    costUsd: number | null;
  }>;
  topRepos: Array<{ repo: string; reviews: number; findings: number }>;
  topPulls: Array<{ repo: string; number: number; title: string; reviews: number; findings: number }>;
  repos: string[];
};

/** `+480 minutes` / `-420 minutes`, clamped to a real offset. Bound as a SQLite modifier. */
export function timezoneModifier(offsetMinutes: number): string {
  if (!Number.isFinite(offsetMinutes)) return "+0 minutes";
  const clamped = Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(offsetMinutes)));
  const sign = clamped >= 0 ? "+" : "-";
  return `${sign}${Math.abs(clamped)} minutes`;
}

/** Aggregate a reviews database. Callers hold the archive lock. */
export function queryReviewStats(db: DatabaseSync, filter: StatsQuery): StatsSnapshot {
  const scope = where("r", filter);
  const overview = one(
    db,
    `SELECT
       COUNT(*) AS reviews,
       SUM(r.outcome = 'completed') AS completed,
       SUM(r.outcome = 'failed') AS failed,
       SUM(r.outcome = 'running') AS running
     FROM reviews r
     WHERE ${scope.clause}`,
    scope.params,
  );
  const duration = one(
    db,
    `WITH finished AS (
       SELECT CAST(ROUND((julianday(r.finished_at) - julianday(r.started_at)) * 86400000.0) AS INTEGER) AS ms
       FROM reviews r
       WHERE ${scope.clause}
         AND r.finished_at IS NOT NULL
         AND r.outcome IN ('completed', 'failed')
         AND julianday(r.finished_at) >= julianday(r.started_at)
     ),
     ranked AS (
       SELECT ms, ROW_NUMBER() OVER (ORDER BY ms) AS rn, COUNT(*) OVER () AS n FROM finished
     )
     SELECT
       (SELECT AVG(ms) FROM finished) AS avg_ms,
       (SELECT ms FROM ranked WHERE rn = ((n * 95 + 99) / 100) LIMIT 1) AS p95_ms,
       (SELECT COUNT(*) FROM finished) AS samples`,
    scope.params,
  );
  const priorities = one(
    db,
    `WITH scoped AS (
       SELECT r.task_id, r.p0, r.p1, r.p2, r.p3, r.counts_known
       FROM reviews r
       WHERE ${scope.clause}
     ),
     from_findings AS (
       SELECT task_id,
         SUM(priority = 0) AS p0,
         SUM(priority = 1) AS p1,
         SUM(priority = 2) AS p2,
         SUM(priority = 3) AS p3
       FROM findings
       WHERE task_id IN (SELECT task_id FROM scoped)
       GROUP BY task_id
     )
     SELECT
       SUM(COALESCE(f.p0, CASE WHEN s.counts_known = 1 THEN s.p0 ELSE 0 END)) AS p0,
       SUM(COALESCE(f.p1, CASE WHEN s.counts_known = 1 THEN s.p1 ELSE 0 END)) AS p1,
       SUM(COALESCE(f.p2, CASE WHEN s.counts_known = 1 THEN s.p2 ELSE 0 END)) AS p2,
       SUM(COALESCE(f.p3, CASE WHEN s.counts_known = 1 THEN s.p3 ELSE 0 END)) AS p3,
       SUM(CASE WHEN f.task_id IS NULL AND s.counts_known = 0 THEN 1 ELSE 0 END) AS unknown_reviews
     FROM scoped s
     LEFT JOIN from_findings f ON f.task_id = s.task_id`,
    scope.params,
  );
  const verdicts = one(
    db,
    `SELECT
       SUM(r.verdict = 'block') AS block,
       SUM(r.verdict = 'fix_recommended') AS fix_recommended,
       SUM(r.verdict = 'clean') AS clean,
       SUM(r.verdict IS NULL OR r.verdict NOT IN ('block', 'fix_recommended', 'clean')) AS unknown
     FROM reviews r
     WHERE ${scope.clause} AND r.outcome = 'completed'`,
    scope.params,
  );
  const tokens = one(
    db,
    `SELECT
       COUNT(*) AS known_reviews,
       SUM(r.input_tokens) AS input_tokens,
       SUM(r.output_tokens) AS output_tokens,
       SUM(r.cache_read_tokens) AS cache_read_tokens,
       SUM(r.reasoning_tokens) AS reasoning_tokens,
       SUM(r.cost_usd) AS cost_usd,
       SUM(CASE WHEN r.cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS cost_known,
       AVG(r.input_tokens) AS avg_input,
       AVG(r.output_tokens) AS avg_output,
       AVG(r.input_tokens + r.output_tokens + COALESCE(r.cache_read_tokens, 0)) AS avg_total
     FROM reviews r
     WHERE ${scope.clause} AND r.input_tokens IS NOT NULL`,
    scope.params,
  );
  const modifier = timezoneModifier(filter.tzOffsetMinutes);
  const trend = db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d', r.started_at, ?) AS day,
         CASE WHEN r.model IS NULL OR TRIM(r.model) = '' THEN '(unknown model)' ELSE r.model END AS model,
         SUM(r.input_tokens) AS input_tokens,
         SUM(r.output_tokens) AS output_tokens,
         SUM(r.cache_read_tokens) AS cache_read_tokens,
         SUM(r.reasoning_tokens) AS reasoning_tokens,
         COUNT(*) AS reviews
       FROM reviews r
       WHERE ${scope.clause} AND r.input_tokens IS NOT NULL
       GROUP BY day, model
       ORDER BY day, model`,
    )
    .all(modifier, ...scope.params);
  const failures = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(r.error), ''), '(no reason recorded)') AS reason, COUNT(*) AS n
       FROM reviews r
       WHERE ${scope.clause} AND r.outcome = 'failed'
       GROUP BY reason
       ORDER BY n DESC, reason
       LIMIT 12`,
    )
    .all(...scope.params);
  const expensive = db
    .prepare(
      `WITH ranked AS (
         SELECT r.owner, r.repo, r.number, r.title, r.input_tokens, r.output_tokens,
                COALESCE(r.cache_read_tokens, 0) AS cache_read_tokens, r.cost_usd, r.started_at,
                ROW_NUMBER() OVER (PARTITION BY r.owner, r.repo, r.number ORDER BY r.started_at DESC) AS rn
         FROM reviews r
         WHERE ${scope.clause} AND r.input_tokens IS NOT NULL
       )
       SELECT owner, repo, number,
              MAX(CASE WHEN rn = 1 THEN title END) AS title,
              COUNT(*) AS reviews,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cost_usd) AS cost_usd
       FROM ranked
       GROUP BY owner, repo, number
       ORDER BY COALESCE(SUM(cost_usd), -1) DESC,
                SUM(input_tokens + output_tokens + cache_read_tokens) DESC,
                owner, repo, number
       LIMIT 8`,
    )
    .all(...scope.params);
  const topRepos = db
    .prepare(
      `SELECT r.owner || '/' || r.repo AS repo,
              COUNT(*) AS reviews,
              SUM(CASE WHEN r.counts_known = 1 THEN r.p0 + r.p1 + r.p2 + r.p3 ELSE COALESCE(r.finding_count, 0) END) AS findings
       FROM reviews r
       WHERE ${scope.clause}
       GROUP BY r.owner, r.repo
       ORDER BY reviews DESC, findings DESC, repo
       LIMIT 8`,
    )
    .all(...scope.params);
  const topPulls = db
    .prepare(
      `WITH ranked AS (
         SELECT r.owner, r.repo, r.number, r.title, r.started_at,
                CASE WHEN r.counts_known = 1 THEN r.p0 + r.p1 + r.p2 + r.p3 ELSE COALESCE(r.finding_count, 0) END AS findings,
                ROW_NUMBER() OVER (PARTITION BY r.owner, r.repo, r.number ORDER BY r.started_at DESC) AS rn
         FROM reviews r
         WHERE ${scope.clause}
       )
       SELECT owner, repo, number,
              MAX(CASE WHEN rn = 1 THEN title END) AS title,
              COUNT(*) AS reviews,
              SUM(findings) AS findings
       FROM ranked
       GROUP BY owner, repo, number
       ORDER BY findings DESC, reviews DESC, owner, repo, number
       LIMIT 8`,
    )
    .all(...scope.params);
  const categories = db
    .prepare(
      `SELECT category, COUNT(*) AS n FROM (
         SELECT CASE WHEN TRIM(f.category) = '' THEN 'unknown' ELSE f.category END AS category
         FROM findings f
         JOIN reviews r ON r.task_id = f.task_id
         WHERE ${scope.clause}
         UNION ALL
         SELECT CASE WHEN TRIM(c.category) = '' THEN 'unknown' ELSE c.category END AS category
         FROM comments c
         JOIN reviews r ON r.task_id = c.task_id
         WHERE ${scope.clause}
           AND NOT EXISTS (SELECT 1 FROM findings f WHERE f.task_id = c.task_id)
       )
       GROUP BY category
       ORDER BY n DESC, category`,
    )
    .all(...scope.params, ...scope.params);
  const repos = db
    .prepare("SELECT DISTINCT owner, repo FROM reviews ORDER BY owner, repo")
    .all()
    .map((row) => `${text(row, "owner")}/${text(row, "repo")}`)
    .filter((repo) => repo !== "/");

  const known = int(tokens, "known_reviews");
  const cacheRead = tokens.cache_read_tokens === null ? null : int(tokens, "cache_read_tokens");
  const reasoning = tokens.reasoning_tokens === null ? null : int(tokens, "reasoning_tokens");
  const cost = tokens.cost_usd === null || tokens.cost_usd === undefined ? null : num(tokens, "cost_usd");
  return {
    reviews: int(overview, "reviews"),
    completed: int(overview, "completed"),
    failed: int(overview, "failed"),
    running: int(overview, "running"),
    avgDurationMs: duration.avg_ms === null ? null : num(duration, "avg_ms"),
    p95DurationMs: duration.p95_ms === null ? null : num(duration, "p95_ms"),
    durationSamples: int(duration, "samples"),
    failures: failures.map((row) => ({ reason: text(row, "reason"), count: int(row, "n") })),
    priorities: {
      p0: int(priorities, "p0"),
      p1: int(priorities, "p1"),
      p2: int(priorities, "p2"),
      p3: int(priorities, "p3"),
      unknownReviews: int(priorities, "unknown_reviews"),
    },
    categories: categories
      .map((row) => ({ category: text(row, "category") || "unknown", count: int(row, "n") }))
      .filter((row) => row.count > 0),
    verdicts: {
      block: int(verdicts, "block"),
      fixRecommended: int(verdicts, "fix_recommended"),
      clean: int(verdicts, "clean"),
      unknown: int(verdicts, "unknown"),
    },
    trend: trend.map((row) => {
      const inputTokens = int(row, "input_tokens");
      const outputTokens = int(row, "output_tokens");
      const cache = row.cache_read_tokens === null ? 0 : int(row, "cache_read_tokens");
      return {
        day: text(row, "day"),
        model: text(row, "model"),
        inputTokens,
        outputTokens,
        cacheReadTokens: row.cache_read_tokens === null ? 0 : cache,
        reasoningTokens: row.reasoning_tokens === null ? 0 : int(row, "reasoning_tokens"),
        totalTokens: inputTokens + outputTokens + cache,
        reviews: int(row, "reviews"),
      };
    }),
    tokens: {
      knownReviews: known,
      unknownReviews: Math.max(0, int(overview, "reviews") - known),
      avgInput: known === 0 ? null : num(tokens, "avg_input"),
      avgOutput: known === 0 ? null : num(tokens, "avg_output"),
      avgTotal: known === 0 ? null : num(tokens, "avg_total"),
      totalInput: int(tokens, "input_tokens"),
      totalOutput: int(tokens, "output_tokens"),
      totalCacheRead: cacheRead,
      totalReasoning: reasoning,
      totalCostUsd: cost,
      costKnownReviews: int(tokens, "cost_known"),
    },
    expensive: expensive.map((row) => ({
      repo: `${text(row, "owner")}/${text(row, "repo")}`,
      number: int(row, "number"),
      title: text(row, "title"),
      reviews: int(row, "reviews"),
      totalTokens: int(row, "input_tokens") + int(row, "output_tokens") + int(row, "cache_read_tokens"),
      costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : num(row, "cost_usd"),
    })),
    topRepos: topRepos.map((row) => ({
      repo: text(row, "repo"),
      reviews: int(row, "reviews"),
      findings: int(row, "findings"),
    })),
    topPulls: topPulls.map((row) => ({
      repo: `${text(row, "owner")}/${text(row, "repo")}`,
      number: int(row, "number"),
      title: text(row, "title"),
      reviews: int(row, "reviews"),
      findings: int(row, "findings"),
    })),
    repos,
  };
}

function where(alias: string, filter: StatsQuery): { clause: string; params: SQLInputValue[] } {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.repo) {
    parts.push(`${alias}.owner || '/' || ${alias}.repo = ?`);
    params.push(filter.repo);
  }
  if (filter.since) {
    parts.push(`${alias}.started_at >= ?`);
    params.push(filter.since);
  }
  return { clause: parts.length > 0 ? parts.join(" AND ") : "1 = 1", params };
}

function one(db: DatabaseSync, sql: string, params: SQLInputValue[]): Record<string, SQLOutputValue> {
  return db.prepare(sql).get(...params) ?? {};
}

function text(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function int(row: Record<string, SQLOutputValue>, key: string): number {
  const value = num(row, key);
  if (value === null) return 0;
  return Math.trunc(value);
}

function num(row: Record<string, SQLOutputValue>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}
