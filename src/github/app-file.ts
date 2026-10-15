import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type StoredGitHubApp = {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  slug: string;
  name: string;
  htmlUrl: string;
};

/** GitHub App created from the settings page. Env vars are applied later and win. */
export class GitHubAppFile {
  #current: StoredGitHubApp | undefined;
  #unreadable = false;

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<GitHubAppFile> {
    const store = new GitHubAppFile(file);
    await store.#load();
    return store;
  }

  current(): StoredGitHubApp | undefined {
    return this.#current;
  }

  unreadable(): boolean {
    return this.#unreadable;
  }

  async save(app: StoredGitHubApp): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.file), 0o700);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(app, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
    await chmod(this.file, 0o600);
    this.#current = app;
    this.#unreadable = false;
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
    this.#current = undefined;
    this.#unreadable = false;
  }

  async #load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.#unreadable = true;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const app = parseStoredGitHubApp(parsed);
      if (!app) {
        this.#unreadable = true;
        return;
      }
      this.#current = app;
    } catch {
      this.#unreadable = true;
    }
  }
}

export function parseStoredGitHubApp(value: unknown): StoredGitHubApp | undefined {
  if (!isRecord(value)) return undefined;
  const appId = positiveId(value.appId);
  const privateKey = secretText(value.privateKey, 20_000);
  const webhookSecret = secretText(value.webhookSecret, 500);
  const slug = slugText(value.slug);
  const name = plainText(value.name, 80);
  const htmlUrl = value.htmlUrl === undefined || value.htmlUrl === "" ? "" : httpsUrl(value.htmlUrl);
  if (!appId || !privateKey || !webhookSecret || !slug || !name || htmlUrl === undefined) return undefined;
  if (!privateKey.includes("PRIVATE KEY")) return undefined;
  return { appId, privateKey, webhookSecret, slug, name, htmlUrl };
}

function positiveId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value) || value === "0") return undefined;
  return value;
}

function secretText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > max) return undefined;
  if (trimmed.includes("\u0000")) return undefined;
  return value.includes("BEGIN") ? value.replace(/\\n/g, "\n") : trimmed;
}

function slugText(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(value)) return undefined;
  return value;
}

function plainText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || /[\r\n\u0000]/.test(trimmed)) return undefined;
  return trimmed;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 300) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
