import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "./config.js";
import { dispatch, type DispatchContext } from "./http/dispatch.js";
import { log } from "./log.js";
import { startBuiltServer } from "./prod.js";
import type { DureviewService, ServiceOptions } from "./service.js";

export type HttpOptions = {
  host: string;
  port: number;
  /** Unset disables the status page. Never written into a response. */
  uiToken?: string;
  dataDir?: string;
  githubApp?: boolean;
  githubToken?: boolean;
  githubApiUrl?: string;
  provider?: string;
  modelId?: string;
  startedAt?: number;
};

export async function serveCommand(config: Config): Promise<void> {
  await startBuiltServer(config);
}

/**
 * In-process listener for tests. Production listens through the TanStack Start
 * server (`npm start` / `node .output/server/index.mjs`), which calls the same
 * webhook, login, list, and detail helpers.
 */
export async function startHttp(
  service: DureviewService,
  config: HttpOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const ctx: DispatchContext = {
    service,
    uiToken: config.uiToken,
    dataDir: config.dataDir,
    provider: config.provider ?? "unknown",
    modelId: config.modelId ?? "unknown",
    thinking: "medium",
    githubApp: config.githubApp === true,
    githubToken: config.githubToken === true,
    githubApiUrl: config.githubApiUrl ?? "https://api.github.com",
    startedAt: config.startedAt ?? Date.now(),
  };
  const nodeServer = createServer((req, res) => {
    void handle(ctx, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    nodeServer.once("error", reject);
    nodeServer.listen(config.port, config.host, () => resolve());
  });
  const address = nodeServer.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        nodeServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(ctx: DispatchContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const request = await toRequest(req);
    const response = await dispatch(ctx, request);
    await writeResponse(res, response);
  } catch (error) {
    log("error", "request failed", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) {
      const payload = JSON.stringify({ error: "internal error" });
      res.writeHead(500, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    }
  }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  const skip = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || skip.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else headers.set(key, value);
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers });
  const limit = url.pathname.replace(/\/+$/, "") === "/webhook" ? 5_000_000 : 8_192;
  const raw = method === "POST" ? await readBody(req, limit) : Buffer.alloc(0);
  return new Request(url, { method, headers, body: new Uint8Array(raw) });
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | number | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie") return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 1) {
    const cookie = cookies[0];
    if (cookie) headers["set-cookie"] = cookie;
  } else if (cookies.length > 1) {
    headers["set-cookie"] = cookies;
  }
  const body = Buffer.from(await response.arrayBuffer());
  headers["content-length"] = body.length;
  res.writeHead(response.status, headers);
  res.end(body);
}

export type { ServiceOptions };
