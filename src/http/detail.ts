import type { DureviewService } from "../service.js";
import { safeNextPath } from "../ui/auth.js";
import { loadReviewDetail } from "../ui/detail-data.js";
import { resolveLocale } from "../ui/locale.js";
import { renderDetailHtml, renderLoginHtml } from "../ui/render-react.js";
import { gateGetPage } from "./auth.js";
import { htmlResponse, notFoundJson, unauthorizedJson } from "./headers.js";

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function reviewDetailResponse(input: {
  service: DureviewService;
  uiToken: string | undefined;
  githubApiUrl: string;
  taskId: string;
  request: Request;
}): Promise<Response> {
  const taskId = TASK_ID.test(input.taskId) ? input.taskId : "";
  const path = taskId ? `/ui/reviews/${taskId}` : "/ui";
  const gate = gateGetPage(input.request, input.uiToken);
  if (gate === "disabled" || !taskId) return notFoundJson();
  if (gate === "challenge") return unauthorizedJson();
  const locale = resolveLocale(input.request);
  if (gate === "login") return htmlResponse(renderLoginHtml({ next: safeNextPath(path), locale }), 401);
  const model = await loadReviewDetail(input.service, input.githubApiUrl, taskId, Date.now(), locale);
  if (!model) return notFoundJson();
  return htmlResponse(await renderDetailHtml(model, locale));
}
