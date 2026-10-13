import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { assertServeConfig, type Config } from "./config.js";
import { createReviewModels, resolveProvider } from "./auth/session.js";
import { GithubRest } from "./github/client.js";
import { log } from "./log.js";
import { GitCheckout } from "./review/checkout.js";
import { DureviewService, type ServiceOptions } from "./service.js";
import { authorizeUi } from "./ui/auth.js";
import { renderReviewDetail, renderReviewList } from "./ui/page.js";
import { reviewFilterFromSearch } from "./ui/query.js";
import { loadDashboard } from "./ui/status.js";

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

const UI_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export async function serveCommand(config: Config): Promise<void> {
  assertServeConfig(config);
  const models = createReviewModels(config);
  const provider = await resolveProvider(config, models);
  const model = models.getModel(provider, config.modelId);
  if (!model) {
    throw new Error(
      `Model ${provider}/${config.modelId} is not in the pi-ai catalog. Set DUREVIEW_MODEL to a model pi-ai exposes.`,
    );
  }
  const auth = await models.checkAuth(provider);
  if (!auth) {
    log("warn", "No credentials for the model provider yet. Run `dureview login` or set OPENAI_API_KEY.", {
      provider,
    });
  }
  const github = new GithubRest(config);
  const checkout = new GitCheckout(
    github,
    join(config.dataDir, "checkouts"),
    (request, signal) => github.accessToken(request, signal),
    { trigger: config.defaultTrigger },
  );
  const service = await DureviewService.open({
    config,
    models,
    github,
    checkout,
    provider,
    modelId: config.modelId,
  });
  const startedAt = Date.now();
  const http = await startHttp(service, {
    host: config.host,
    port: config.port,
    uiToken: config.uiToken,
    dataDir: config.dataDir,
    githubApp: Boolean(config.githubAppId && config.githubAppPrivateKey),
    githubToken: Boolean(config.githubToken),
    githubApiUrl: config.githubApiUrl,
    provider,
    modelId: config.modelId,
    startedAt,
  });
  log("info", "dureview listening", {
    url: http.url,
    provider,
    model: config.modelId,
    github: config.githubAppId ? "app" : "pat",
    ui: config.uiToken ? "enabled" : "disabled",
  });

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await http.close();
  await service.close();
  log("info", "dureview stopped");
}

export async function startHttp(
  service: DureviewService,
  config: HttpOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void handle(service, config, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const host = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(
  service: DureviewService,
  config: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = req.url?.split("?")[0] ?? "/";
    if (req.method === "GET" && (url === "/health" || url === "/health/")) {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "POST" && (url === "/webhook" || url === "/webhook/")) {
      const raw = await readBody(req, 5_000_000);
      const result = await service.handleWebhook(raw, header(req, "x-hub-signature-256"), header(req, "x-github-event"));
      send(res, result.status, result.body);
      return;
    }
    // The review pages are off unless DUREVIEW_UI_TOKEN is set. Health and webhook are unchanged.
    const route = req.method === "GET" ? uiRoute(url) : null;
    if (config.uiToken && route) {
      await serveUi(service, config, req, res, config.uiToken, route);
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (error) {
    log("error", "request failed", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  }
}

type UiRoute = { kind: "list" } | { kind: "detail"; taskId: string };

function uiRoute(path: string): UiRoute | null {
  if (path === "/" || path === "/ui" || path === "/ui/") return { kind: "list" };
  const detail = /^\/ui\/reviews\/([A-Za-z0-9_-]{1,64})\/?$/.exec(path);
  const taskId = detail?.[1];
  if (taskId) return { kind: "detail", taskId };
  return null;
}

async function serveUi(
  service: DureviewService,
  config: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  route: UiRoute,
): Promise<void> {
  if (!authorizeUi(header(req, "authorization"), token)) {
    sendUnauthorized(res);
    return;
  }
  if (route.kind === "detail") {
    const detail = await service.reviewForUi(route.taskId, AbortSignal.timeout(20_000));
    if (!detail) {
      send(res, 404, { error: "not found" });
      return;
    }
    sendHtml(
      res,
      renderReviewDetail({
        review: detail.review,
        files: detail.files,
        diffUnavailable: detail.diffUnavailable,
        githubApiUrl: config.githubApiUrl ?? "https://api.github.com",
      }),
    );
    return;
  }
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const query = reviewFilterFromSearch(parsed.searchParams);
  const listed = await service.reviewsForUi(query.filter);
  const status = await loadDashboard({
    dataDir: config.dataDir,
    provider: config.provider ?? "unknown",
    model: config.modelId ?? "unknown",
    githubApp: config.githubApp === true,
    githubToken: config.githubToken === true,
    startedAt: config.startedAt ?? Date.now(),
  });
  sendHtml(
    res,
    renderReviewList({
      status,
      reviews: listed.reviews,
      repos: listed.repos,
      total: listed.total,
      form: query.form,
    }),
  );
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
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

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    ...UI_HEADERS,
  });
  res.end(html);
}

function sendUnauthorized(res: ServerResponse): void {
  const payload = JSON.stringify({ error: "unauthorized" });
  res.writeHead(401, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "www-authenticate": 'Basic realm="dureview", charset="UTF-8"',
    ...UI_HEADERS,
  });
  res.end(payload);
}

export type { ServiceOptions };
