import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type AuthFile = Record<string, Credential>;

const LOCK_STALE_MS = 180_000;

/**
 * One credential per provider in `auth.json` on the data volume.
 *
 * `modify` is the only write path. pi-ai refreshes Codex OAuth inside `modify`,
 * so a rotated refresh token is written back before the next request can use
 * the old one. An in-process queue plus a lock file keeps that read-modify-write
 * exclusive, including when `dureview login` runs beside a stopped server.
 */
export class FileCredentialStore implements CredentialStore {
  #chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    throwIfAborted(options?.signal);
    const data = await this.#load();
    return data[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<CredentialInfo[]> {
    throwIfAborted(options?.signal);
    const data = await this.#load();
    return Object.entries(data).map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    throwIfAborted(options?.signal);
    return this.#exclusive(async () => {
      throwIfAborted(options?.signal);
      const data = await this.#load();
      const current = data[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      data[providerId] = next;
      await this.#save(data);
      return next;
    });
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    throwIfAborted(options?.signal);
    await this.#exclusive(async () => {
      const data = await this.#load();
      if (data[providerId] === undefined) return;
      delete data[providerId];
      await this.#save(data);
    });
  }

  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(() => withFileLock(lockPath(this.file), fn), () => withFileLock(lockPath(this.file), fn));
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #load(): Promise<AuthFile> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (isEnoent(error)) return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid credential file ${this.file}: expected an object`);
    }
    return parsed as AuthFile;
  }

  async #save(data: AuthFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}

function lockPath(file: string): string {
  return `${file}.lock`;
}

async function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        return await fn();
      } finally {
        await handle.close();
        await rm(file, { force: true });
      }
    } catch (error) {
      if (!isEexist(error)) throw error;
      await stealStaleLock(file);
      if (Date.now() - started > LOCK_STALE_MS) {
        throw new Error(`Timed out waiting for credential lock ${file}`);
      }
      await delay(25);
    }
  }
}

async function stealStaleLock(file: string): Promise<void> {
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(file, { force: true });
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
