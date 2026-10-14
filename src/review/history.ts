import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../log.js";
import type { RecordedFinding } from "./findings.js";
import type { ReviewPolicy } from "./policy.js";
import type { Finding } from "./schema.js";
import type { ReviewUsage } from "./usage.js";

/** How many reviews `reviews.json` keeps. Newest entries stay. */
export const MAX_REVIEWS = 50;

const NAME = /^[A-Za-z0-9_.-]+$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRIGGERS = new Set(["opened", "synchronize", "reopened", "ready_for_review", "command", "unknown"]);

/**
 * Outcome written when a review task finishes.
 * Finding text, diffs, credentials, and failure reasons are intentionally absent
 * from `reviews.json`. The archive may store `error` separately.
 */
export type ReviewFinished = {
  taskId: string;
  owner: string;
  repo: string;
  number: number;
  outcome: "completed" | "failed";
  verdict: "block" | "fix_recommended" | "clean" | null;
  findingCount: number | null;
  /**
   * Optional context for the review archive. `reviews.json` does not store these.
   * Finding text and the failure reason stay out of the short log.
   */
  title?: string;
  sha?: string;
  baseSha?: string;
  baseRef?: string;
  installationId?: number | null;
  verdictReason?: string | null;
  overallConfidence?: number | null;
  checked?: string[];
  policy?: ReviewPolicy | null;
  findings?: Finding[];
  provider?: string;
  modelId?: string;
  /** Thinking level the review ran with. Not written to `reviews.json`. */
  thinking?: string;
  /** Failure reason for the archive only. Not written to `reviews.json`. */
  error?: string;
  /**
   * Model spend from pi-ai. Absent when the conversation could not be read.
   * Not written to `reviews.json`. A captured zero is different from absent.
   */
  usage?: ReviewUsage;
  /**
   * Every finding, including ones that were not posted. Not written to `reviews.json`.
   * When absent, a completed review still stores `findings` with posting left unknown.
   */
  recordedFindings?: RecordedFinding[];
};

export type ReviewLogEntry = {
  taskId: string;
  owner: string;
  repo: string;
  number: number;
  /** Pull request action, `command` for `/dureview`, or `unknown`. */
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: "running" | "completed" | "failed";
  verdict: "block" | "fix_recommended" | "clean" | null;
  findingCount: number | null;
};

type Loaded = { ok: true; entries: ReviewLogEntry[] } | { ok: false };

/**
 * Bounded recent-review log in the data directory (`reviews.json`, mode 0600).
 * Writes are serialized in-process. A corrupt file is left in place.
 */
export class ReviewLog {
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  start(input: { taskId: string; owner: string; repo: string; number: number; trigger: string }): Promise<void> {
    const identity = cleanIdentity(input);
    if (!identity) return Promise.resolve();
    const trigger = TRIGGERS.has(input.trigger) ? input.trigger : "unknown";
    const startedAt = new Date().toISOString();
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (!loaded.ok) return;
      const existing = loaded.entries.find((entry) => entry.taskId === identity.taskId);
      if (existing) {
        if (existing.trigger === "unknown" && trigger !== "unknown") {
          existing.trigger = trigger;
          await this.#save(loaded.entries);
        }
        return;
      }
      loaded.entries.unshift({
        ...identity,
        trigger,
        startedAt,
        finishedAt: null,
        outcome: "running",
        verdict: null,
        findingCount: null,
      });
      await this.#save(loaded.entries.slice(0, MAX_REVIEWS));
    });
  }

  finish(event: ReviewFinished): Promise<void> {
    const identity = cleanIdentity(event);
    if (!identity) return Promise.resolve();
    if (event.outcome !== "completed" && event.outcome !== "failed") return Promise.resolve();
    const finishedAt = new Date().toISOString();
    const verdict = event.outcome === "completed" ? cleanVerdict(event.verdict) : null;
    const findingCount = event.outcome === "completed" ? cleanCount(event.findingCount) : null;
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (!loaded.ok) return;
      const existing = loaded.entries.find((entry) => entry.taskId === identity.taskId);
      if (existing) {
        existing.outcome = event.outcome;
        existing.finishedAt = finishedAt;
        existing.verdict = verdict;
        existing.findingCount = findingCount;
        await this.#save(loaded.entries);
        return;
      }
      loaded.entries.unshift({
        ...identity,
        trigger: "unknown",
        startedAt: finishedAt,
        finishedAt,
        outcome: event.outcome,
        verdict,
        findingCount,
      });
      await this.#save(loaded.entries.slice(0, MAX_REVIEWS));
    });
  }

  list(): Promise<ReviewLogEntry[]> {
    return this.#exclusive(async () => {
      const loaded = await this.#load();
      if (!loaded.ok) return [];
      return loaded.entries.map((entry) => ({ ...entry }));
    });
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #load(): Promise<Loaded> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, entries: [] };
      log("error", "could not read review log", { error: (error as NodeJS.ErrnoException).code ?? "unknown" });
      return { ok: false };
    }
    if (text.trim() === "") return { ok: true, entries: [] };
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || !Array.isArray(parsed.reviews)) {
        log("error", "could not read review log", { error: "invalid" });
        return { ok: false };
      }
      const entries: ReviewLogEntry[] = [];
      for (const item of parsed.reviews) {
        const entry = parseEntry(item);
        if (entry) entries.push(entry);
      }
      return { ok: true, entries: entries.slice(0, MAX_REVIEWS) };
    } catch {
      log("error", "could not read review log", { error: "invalid" });
      return { ok: false };
    }
  }

  async #save(entries: ReviewLogEntry[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ reviews: entries }, null, 2)}\n`;
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }
}

function cleanIdentity(input: { taskId: string; owner: string; repo: string; number: number }):
  | Pick<ReviewLogEntry, "taskId" | "owner" | "repo" | "number">
  | undefined {
  if (typeof input.taskId !== "string" || !TASK_ID.test(input.taskId)) return undefined;
  if (typeof input.owner !== "string" || !NAME.test(input.owner) || input.owner.length > 100) return undefined;
  if (typeof input.repo !== "string" || !NAME.test(input.repo) || input.repo.length > 100) return undefined;
  if (!Number.isInteger(input.number) || input.number < 1 || input.number > 1_000_000_000) return undefined;
  return { taskId: input.taskId, owner: input.owner, repo: input.repo, number: input.number };
}

function cleanVerdict(value: ReviewFinished["verdict"]): ReviewLogEntry["verdict"] {
  if (value === "block" || value === "fix_recommended" || value === "clean") return value;
  return null;
}

function cleanCount(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 10_000) return null;
  return value;
}

function parseEntry(value: unknown): ReviewLogEntry | undefined {
  if (!isRecord(value)) return undefined;
  const identity = cleanIdentity({
    taskId: typeof value.taskId === "string" ? value.taskId : "",
    owner: typeof value.owner === "string" ? value.owner : "",
    repo: typeof value.repo === "string" ? value.repo : "",
    number: typeof value.number === "number" ? value.number : 0,
  });
  if (!identity) return undefined;
  if (typeof value.trigger !== "string" || !TRIGGERS.has(value.trigger)) return undefined;
  if (typeof value.startedAt !== "string" || !isIso(value.startedAt)) return undefined;
  if (value.finishedAt !== null && (typeof value.finishedAt !== "string" || !isIso(value.finishedAt))) return undefined;
  if (value.outcome !== "running" && value.outcome !== "completed" && value.outcome !== "failed") return undefined;
  if (value.verdict !== null && value.verdict !== "block" && value.verdict !== "fix_recommended" && value.verdict !== "clean") {
    return undefined;
  }
  if (
    value.findingCount !== null &&
    (typeof value.findingCount !== "number" || !Number.isInteger(value.findingCount) || value.findingCount < 0 || value.findingCount > 10_000)
  ) {
    return undefined;
  }
  return {
    ...identity,
    trigger: value.trigger,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    outcome: value.outcome,
    verdict: value.verdict,
    findingCount: value.findingCount,
  };
}

function isIso(value: string): boolean {
  return value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
