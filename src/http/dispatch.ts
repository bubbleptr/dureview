import type { DureviewService } from "../service.js";
import { safeNextPath } from "../ui/auth.js";
import type { ListContext } from "../ui/list-data.js";
import { buildReviewList, searchParamsFrom } from "../ui/list-data.js";
import { renderListHtml, renderLoginHtml } from "../ui/render-react.js";
import { gateGetPage, uiSession } from "./auth.js";
import { reviewDetailResponse } from "./detail.js";
import { htmlResponse, notFoundJson, redirectResponse, unauthorizedJson } from "./headers.js";
import { loginPostResponse } from "./login.js";
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
  if (method === "GET" && (pathname === "/" || pathname === "/ui")) return listDispatch(ctx, request, pathname);
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

async function listDispatch(ctx: DispatchContext, request: Request, pathname: string): Promise<Response> {
  const gate = gateGetPage(request, ctx.uiToken);
  if (gate === "disabled") return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  if (gate === "login") return htmlResponse(renderLoginHtml({ next: safeNextPath(pathname) }), 401);
  const model = await buildReviewList(ctx, searchParamsFrom(new URL(request.url).search));
  return htmlResponse(renderListHtml(model));
}

function stripTrailingSlash(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.replace(/\/+$/, "");
  return pathname;
}
