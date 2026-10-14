import { createServerFn } from "@tanstack/react-start";
import type { DetailPayload } from "./detail-data.js";
import { safeNextPath } from "./next-path.js";

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const getReviewDetail = createServerFn({ method: "GET" })
  .validator((input: { taskId: string }) => ({
    taskId: typeof input?.taskId === "string" && TASK_ID.test(input.taskId) ? input.taskId : "",
  }))
  .handler(async ({ data }): Promise<DetailPayload> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const { getRuntime } = await import("../app/runtime.js");
    const { uiSession } = await import("../http/auth.js");
    const { loadReviewDetail } = await import("./detail-data.js");
    const runtime = await getRuntime();
    const request = getRequest();
    const next = safeNextPath(data.taskId ? `/ui/reviews/${data.taskId}` : "/ui");
    if (uiSession(request, runtime.config.uiToken) !== "ok") return { kind: "login", next };
    if (!data.taskId) return { kind: "missing" };
    const model = await loadReviewDetail(runtime.service, runtime.config.githubApiUrl, data.taskId);
    if (!model) return { kind: "missing" };
    const { preloadReviewPresentation } = await import("./review-preload.js");
    return { kind: "detail", model, presentation: await preloadReviewPresentation(model) };
  });
