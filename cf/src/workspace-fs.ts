import type { Workspace } from "@cloudflare/computer";
import type { RepoDirent, RepoFileKind, RepoFs, RepoStat } from "../../src/review/repo.js";

type WorkspaceFs = Workspace["fs"];

const MAX_SYMLINKS = 16;

/** Map the workspace virtual filesystem onto the read/grep interface. No exec. */
export class WorkspaceRepoFs implements RepoFs {
  constructor(private readonly fs: WorkspaceFs) {}

  async realpath(request: string): Promise<string> {
    return this.#walk(normalizePosix(request), 0);
  }

  async stat(file: string): Promise<RepoStat> {
    const info = await this.fs.stat(file);
    return { kind: kindOf(info), size: info.size };
  }

  readFile(file: string, encoding: "utf8"): Promise<string> {
    return this.fs.readFile(file, encoding);
  }

  async readdir(dir: string): Promise<RepoDirent[]> {
    const entries = await this.fs.readdir(dir);
    return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
  }

  async #walk(absolute: string, depth: number): Promise<string> {
    if (depth > MAX_SYMLINKS) throw Object.assign(new Error("Too many symlinks"), { code: "ELOOP" });
    const parts = absolute.split("/").filter((part) => part.length > 0);
    let current = "";
    for (const part of parts) {
      const next = `${current}/${part}`;
      const info = await this.fs.lstat(next);
      if (info.isSymbolicLink) {
        const link = await this.fs.readlink(next);
        const target = link.startsWith("/") ? normalizePosix(link) : normalizePosix(`${current}/${link}`);
        current = await this.#walk(target, depth + 1);
      } else {
        current = next;
      }
    }
    return current || "/";
  }
}

function kindOf(info: { isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }): RepoFileKind {
  if (info.isSymbolicLink) return "symlink";
  if (info.isDirectory) return "directory";
  if (info.isFile) return "file";
  return "other";
}

function normalizePosix(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
