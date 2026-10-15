import type { DureviewService } from "../service.js";
import { safeNextPath } from "../ui/auth.js";
import type { ListContext } from "../ui/list-data.js";
import { buildReviewList, searchParamsFrom } from "../ui/list-data.js";
import type { ShellStatus } from "../ui/shell-status.js";
import { codexPhrase, formatUptime } from "../ui/page.js";
import { loadDashboard } from "../ui/status.js";
import { buildStatsPage } from "../ui/stats-data.js";
import { renderListHtml, renderLoginHtml, renderOverviewHtml } from "../ui/render-react.js";
import { gateGetPage, uiSession } from "./auth.js";
import { reviewDetailResponse } from "./detail.js";
import { htmlResponse, notFoundJson, redirectResponse, unauthorizedJson } from "./headers.js";
import { loginPostResponse } from "./login.js";
import { settingsGetResponse, settingsPostResponse } from "./settings.js";
import { isKnownSettingsPath, isSettingsCandidate } from "../ui/settings-sections.js";
import { handleWebhookRequest } from "./webhook.js";

export type DispatchContext = ListContext & {
  uiToken?: string;
  githubApiUrl: string;
  service: DureviewService;
};

/** HTTP behavior shared by the test listener. TanStack routes call the same helpers. */
export async function dispatch(ctx: DispatchContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = stripTrailingSlash(url.pathname);
  const method = request.method;
  if (method === "GET" && pathname === "/health") return Response.json({ ok: true });
  if (method === "POST" && pathname === "/webhook") {
    return handleWebhookRequest(ctx.service, ctx.service.configuredWebhookSecret(), request);
  }
  if (pathname === "/ui/login") return loginDispatch(ctx, request);
  if (isSettingsCandidate(pathname)) {
    if (!isKnownSettingsPath(pathname)) return notFoundJson();
    return settingsDispatch(ctx, request);
  }
  if (method === "GET" && pathname === "/ui/stats") {
    return redirectResponse(`/ui${url.search}`);
  }
  if (method === "GET" && pathname === "/ui/reviews") return listDispatch(ctx, request, pathname);
  if (method === "GET" && (pathname === "/" || pathname === "/ui")) return overviewDispatch(ctx, request, pathname);
  const detail = method === "GET" ? /^\/ui\/reviews\/([A-Za-z0-9_-]{1,64})$/.exec(pathname) : null;
  const taskId = detail?.[1];
  if (taskId) {
    return reviewDetailResponse({
      service: ctx.service,
      uiToken: ctx.uiToken,
      githubApiUrl: ctx.githubApiUrl,
      taskId,
      request,
    });
  }
  return notFoundJson();
}

async function loginDispatch(ctx: DispatchContext, request: Request): Promise<Response> {
  if (!ctx.uiToken) return notFoundJson();
  if (request.method === "GET") {
    if (uiSession(request, ctx.uiToken) === "ok") return redirectResponse("/ui");
    return htmlResponse(renderLoginHtml({ next: "/ui" }), 401);
  }
  if (request.method === "POST") return loginPostResponse(request, ctx.uiToken);
  return notFoundJson();
}

async function settingsDispatch(ctx: DispatchContext, request: Request): Promise<Response> {
  const status = await shellStatus(ctx);
  if (request.method === "GET") return settingsGetResponse(ctx.service, ctx.uiToken, request, status);
  if (request.method === "POST") return settingsPostResponse(ctx.service, ctx.uiToken, request, status);
  return notFoundJson();
}

async function listDispatch(ctx: DispatchContext, request: Request, pathname: string): Promise<Response> {
  const gate = gateGetPage(request, ctx.uiToken);
  if (gate === "disabled") return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  if (gate === "login") return htmlResponse(renderLoginHtml({ next: safeNextPath(pathname) }), 401);
  const live = ctx.service.effectiveConfig();
  const model = await buildReviewList(
    { ...ctx, provider: live.provider, modelId: live.modelId, thinking: live.thinking },
    searchParamsFrom(new URL(request.url).search),
  );
  return htmlResponse(renderListHtml(model));
}

async function overviewDispatch(ctx: DispatchContext, request: Request, pathname: string): Promise<Response> {
  const gate = gateGetPage(request, ctx.uiToken);
  if (gate === "disabled") return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  if (gate === "login") return htmlResponse(renderLoginHtml({ next: safeNextPath(pathname) }), 401);
  const model = await buildStatsPage(ctx.service, searchParamsFrom(new URL(request.url).search));
  return htmlResponse(renderOverviewHtml(model));
}

async function shellStatus(ctx: DispatchContext): Promise<ShellStatus> {
  const live = ctx.service.effectiveConfig();
  const status = await loadDashboard({
    dataDir: ctx.dataDir,
    provider: live.provider,
    model: live.modelId,
    githubApp: ctx.githubApp,
    githubToken: ctx.githubToken,
    startedAt: ctx.startedAt,
  });
  return {
    version: status.version,
    uptime: formatUptime(status.uptimeSeconds * 1000),
    dataDir: ctx.dataDir ?? null,
    provider: status.provider,
    model: status.model,
    thinking: live.thinking,
    codex: codexPhrase(status.codex),
    githubApp: status.githubApp,
    githubToken: status.githubToken,
  };
}

function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}
