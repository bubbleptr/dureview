import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export type SettingsAuditRow = {
  key: string;
  action: "set" | "reset";
  previous: string | null;
  value: string | null;
  actor: string;
  at: string;
};

const ACTOR = /^[A-Za-z0-9_.:@-]{1,80}$/;
const AUDIT_KEEP = 200;

/**
 * UI overrides and the audit log in the review database.
 * Tables are created if missing. Existing review rows are left alone.
 */
export class SettingsStore {
  #db: DatabaseSync | undefined;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  static async open(file: string): Promise<SettingsStore> {
    const store = new SettingsStore(file);
    await store.#open();
    return store;
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }

  readAll(): Promise<Map<string, string>> {
    return this.#exclusive(() => this.#readAll());
  }

  /**
   * Replace the override map with `next` and append an audit row for each change.
   * Runs synchronously inside the write lock.
   */
  async writeDiff(
    previous: ReadonlyMap<string, string>,
    next: ReadonlyMap<string, string>,
    actor: string,
    at = new Date().toISOString(),
  ): Promise<void> {
    const who = cleanActor(actor);
    await this.#exclusive(() => {
      const db = this.#database();
      db.exec("BEGIN");
      try {
        const upsert = db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        );
        const remove = db.prepare("DELETE FROM settings WHERE key = ?");
        const audit = db.prepare(
          `INSERT INTO settings_audit (key, action, previous_value, new_value, actor, changed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const keys = new Set([...previous.keys(), ...next.keys()]);
        for (const key of keys) {
          const before = previous.get(key);
          const after = next.get(key);
          if (before === after) continue;
          if (after === undefined) {
            remove.run(key);
            audit.run(key, "reset", before ?? null, null, who, at);
          } else {
            upsert.run(key, after);
            audit.run(key, "set", before ?? null, after, who, at);
          }
        }
        db.prepare(
          `DELETE FROM settings_audit WHERE id NOT IN (
             SELECT id FROM settings_audit ORDER BY id DESC LIMIT ?
           )`,
        ).run(AUDIT_KEEP);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  audit(limit = 20): Promise<SettingsAuditRow[]> {
    const take = Math.min(100, Math.max(1, limit));
    return this.#exclusive(() => {
      const rows = this.#database()
        .prepare(
          `SELECT key, action, previous_value, new_value, actor, changed_at
           FROM settings_audit ORDER BY id DESC LIMIT ?`,
        )
        .all(take);
      const entries: SettingsAuditRow[] = [];
      for (const row of rows) {
        const entry = auditFromRow(row);
        if (entry) entries.push(entry);
      }
      return entries;
    });
  }

  async #open(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS settings_audit (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL,
        action TEXT NOT NULL,
        previous_value TEXT,
        new_value TEXT,
        actor TEXT NOT NULL,
        changed_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#db = db;
    await chmod(this.file, 0o600);
  }

  #readAll(): Map<string, string> {
    const map = new Map<string, string>();
    const rows = this.#database().prepare("SELECT key, value FROM settings").all();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, SQLOutputValue>;
      const key = record.key;
      const value = record.value;
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (key.length === 0 || key.length > 80 || value.length > 80) continue;
      map.set(key, value);
    }
    return map;
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
    if (!this.#db) throw new Error("Settings store is closed.");
    return this.#db;
  }
}

export function cleanActor(value: string): string {
  const trimmed = value.trim();
  if (ACTOR.test(trimmed)) return trimmed;
  return "ui";
}

function auditFromRow(row: Record<string, SQLOutputValue>): SettingsAuditRow | undefined {
  const key = row.key;
  const action = row.action;
  const actor = row.actor;
  const at = row.changed_at;
  if (typeof key !== "string" || typeof actor !== "string" || typeof at !== "string") return undefined;
  if (action !== "set" && action !== "reset") return undefined;
  const previous = row.previous_value;
  const value = row.new_value;
  return {
    key,
    action,
    previous: typeof previous === "string" ? previous : null,
    value: typeof value === "string" ? value : null,
    actor,
    at,
  };
}
