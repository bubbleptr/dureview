import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const paySource = join(here, "../../test/fixtures/repo/src/pay.ts");

export type FixtureGit = {
  base: string;
  sha: string;
  close: () => Promise<void>;
};

/** Smart HTTP remote the Durable Object can shallow-clone. Binds every interface so workerd can reach the host. */
export async function startFixtureGit(): Promise<FixtureGit> {
  const root = join("/tmp", `dureview-cf-git-${process.pid}`);
  await mkdir(join(root, "acme"), { recursive: true });
  const work = join(root, "work");
  const bare = join(root, "acme", "demo.git");
  await mkdir(work, { recursive: true });
  await git(work, ["init", "-b", "main"]);
  await mkdir(join(work, "src"), { recursive: true });
  await writeFile(join(work, "src", "pay.ts"), await readFile(paySource));
  await git(work, ["add", "src/pay.ts"]);
  await git(work, ["commit", "-m", "charge without capture"]);
  const sha = (await git(work, ["rev-parse", "HEAD"])).trim();
  await git(root, ["init", "--bare", bare]);
  await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(work, ["push", bare, "HEAD:refs/heads/main", "HEAD:refs/pull/7/head"]);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://git.local");
    if (url.pathname === "/__stats") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void writeFile("/tmp/dureview-clone-stats.json", Buffer.concat(chunks)).then(() => {
          res.writeHead(204);
          res.end();
        });
      });
      return;
    }
    void serveGit(root, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("git server has no port");
  const base = `http://${advertiseHost()}:${address.port}`;
  const info = await fetch(`${base}/acme/demo.git/info/refs?service=git-upload-pack`);
  const body = await info.text();
  if (!info.ok || !body.includes(sha)) {
    server.close();
    throw new Error(`git smart HTTP did not advertise ${sha}: ${info.status} ${body.slice(0, 200)}`);
  }
  return {
    base,
    sha,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function advertiseHost(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function serveGit(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://git.local");
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.startsWith("?") ? url.search.slice(1) : "",
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: header(req, "content-type"),
      CONTENT_LENGTH: header(req, "content-length"),
    },
  });
  req.pipe(child.stdin);
  const chunks: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on("close", () => {
      const buf = Buffer.concat(chunks);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep < 0) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(stderr || "git http-backend produced no CGI headers");
        resolve();
        return;
      }
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of buf.subarray(0, sep).toString("utf8").split("\r\n")) {
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0] ?? 500);
        else headers[key] = value;
      }
      res.writeHead(status, headers);
      res.end(buf.subarray(sep + 4));
      resolve();
    });
  });
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "dureview",
        GIT_AUTHOR_EMAIL: "dureview@example.com",
        GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "dureview",
        GIT_COMMITTER_EMAIL: "dureview@example.com",
        GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`));
    });
  });
}
