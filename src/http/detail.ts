import type { DureviewService } from "../service.js";
import { safeNextPath } from "../ui/auth.js";
import { renderReviewDetail } from "../ui/page.js";
import { renderLoginHtml } from "../ui/render-react.js";
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
  if (gate === "login") return htmlResponse(renderLoginHtml({ next: safeNextPath(path) }), 401);
  const detail = await input.service.reviewForUi(taskId, AbortSignal.timeout(20_000));
  if (!detail) return notFoundJson();
  return htmlResponse(
    renderReviewDetail({
      review: detail.review,
      files: detail.files,
      diffUnavailable: detail.diffUnavailable,
      githubApiUrl: input.githubApiUrl,
    }),
  );
}
