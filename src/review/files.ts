import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RepoDirent, RepoFileKind, RepoFs, RepoStat } from "./repo.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".next", "build"]);
const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 64_000;
const MAX_GREP_MATCHES = 40;
const MAX_GREP_FILES = 4_000;
const MAX_FILE_BYTES = 512 * 1024;

export type ReadArgs = { path: string; offset?: number; limit?: number };
export type GrepArgs = { pattern: string; path?: string };

export const nodeRepoFs: RepoFs = {
  realpath(file) {
    return realpath(file);
  },
  async stat(file): Promise<RepoStat> {
    const info = await stat(file);
    return { kind: nodeKind(info), size: info.size };
  },
  readFile(file) {
    return readFile(file, "utf8");
  },
  async readdir(dir): Promise<RepoDirent[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, kind: nodeKind(entry) }));
  },
};

export async function readRepoFile(cwd: string, args: ReadArgs, fs: RepoFs = nodeRepoFs): Promise<string> {
  const file = await resolveInside(cwd, args.path, fs);
  const info = await fs.stat(file);
  if (info.kind !== "file") throw new Error(`${args.path} is not a file`);
  if (info.size > MAX_FILE_BYTES * 4) throw new Error(`${args.path} is too large to read`);
  const text = await fs.readFile(file, "utf8");
  if (text.includes("\0")) throw new Error(`${args.path} looks like a binary file`);
  const lines = splitLines(text);
  const offset = normalizeOffset(args.offset);
  const limit = normalizeLimit(args.limit);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(offset + slice.length).length;
  let body = slice.map((line, index) => `${String(offset + index).padStart(width, " ")}|${line}`).join("\n");
  let note = "";
  if (body.length > MAX_READ_CHARS) {
    body = body.slice(0, MAX_READ_CHARS);
    note = "\n[truncated]";
  }
  const remaining = lines.length - (offset - 1 + slice.length);
  if (remaining > 0) note += `\n[${remaining} more lines. Read again with offset ${offset + slice.length}.]`;
  if (slice.length === 0) return `${args.path} has no lines in that range (${lines.length} lines).`;
  return body + note;
}

export async function grepRepo(cwd: string, args: GrepArgs, fs: RepoFs = nodeRepoFs): Promise<string> {
  const base = await fs.realpath(cwd);
  const root = await resolveInside(cwd, args.path ?? ".", fs);
  const matcher = matcherFor(args.pattern);
  const matches: string[] = [];
  let visited = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated || matches.length >= MAX_GREP_MATCHES) return;
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (matches.length >= MAX_GREP_MATCHES || truncated) return;
      if (entry.kind === "symlink") continue;
      const full = path.join(dir, entry.name);
      if (entry.kind === "directory") {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (entry.kind !== "file") continue;
      visited += 1;
      if (visited > MAX_GREP_FILES) {
        truncated = true;
        return;
      }
      const info = await fs.stat(full);
      if (info.size > MAX_FILE_BYTES) continue;
      const text = await fs.readFile(full, "utf8");
      if (text.includes("\0")) continue;
      const lines = splitLines(text);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (!matcher(line)) continue;
        const relative = path.relative(base, full).split(path.sep).join("/");
        matches.push(`${relative}:${index + 1}:${line.trim().slice(0, 240)}`);
        if (matches.length >= MAX_GREP_MATCHES) return;
      }
    }
  }

  const info = await fs.stat(root);
  if (info.kind === "file") {
    const text = await fs.readFile(root, "utf8");
    const lines = splitLines(text);
    for (let index = 0; index < lines.length && matches.length < MAX_GREP_MATCHES; index++) {
      const line = lines[index] ?? "";
      if (matcher(line)) {
        const relative = path.relative(base, root).split(path.sep).join("/");
        matches.push(`${relative}:${index + 1}:${line.trim().slice(0, 240)}`);
      }
    }
  } else {
    await walk(root);
  }
  if (matches.length === 0) return "No matches.";
  return matches.join("\n") + (truncated ? "\n[search stopped at the file limit]" : "");
}

export async function resolveInside(root: string, requestPath: string, fs: RepoFs = nodeRepoFs): Promise<string> {
  if (requestPath.includes("\0")) throw new Error("Invalid path");
  const base = await fs.realpath(root);
  const absolute = path.resolve(base, requestPath);
  const resolved = await fs.realpath(absolute);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error(`Path escapes the repository: ${requestPath}`);
}

function nodeKind(info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): RepoFileKind {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 1;
  return Math.max(1, Math.trunc(offset));
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_READ_LINES;
  return Math.min(MAX_READ_LINES, Math.max(1, Math.trunc(limit)));
}

function matcherFor(pattern: string): (line: string) => boolean {
  try {
    const expression = new RegExp(pattern, "i");
    return (line) => expression.test(line);
  } catch {
    const needle = pattern.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
}
