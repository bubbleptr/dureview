import { createServerFn } from "@tanstack/react-start";
import type { DetailPayload, ReviewHeaderPayload } from "./detail-data.js";
import { safeNextPath } from "./next-path.js";

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const getReviewHeader = createServerFn({ method: "GET" })
  .validator((input: { taskId: string }) => taskInput(input))
  .handler(async ({ data }): Promise<ReviewHeaderPayload> => {
    const opened = await openDetail(data.taskId);
    if (opened.kind !== "ready") return opened;
    const { loadReviewHeader } = await import("./detail-data.js");
    const header = await loadReviewHeader(opened.runtime.service, opened.runtime.config.githubApiUrl, opened.taskId);
    if (!header) return { kind: "missing" };
    return { kind: "header", header };
  });

export const getReviewDetail = createServerFn({ method: "GET" })
  .validator((input: { taskId: string }) => taskInput(input))
  .handler(async ({ data }): Promise<DetailPayload> => {
    const opened = await openDetail(data.taskId);
    if (opened.kind !== "ready") return opened;
    const { loadReviewDetail } = await import("./detail-data.js");
    const model = await loadReviewDetail(opened.runtime.service, opened.runtime.config.githubApiUrl, opened.taskId);
    if (!model) return { kind: "missing" };
    const { reviewTreePreload } = await import("./review-preload.js");
    return { kind: "detail", model, tree: reviewTreePreload(model.files) };
  });

function taskInput(input: { taskId: string }): { taskId: string } {
  return {
    taskId: typeof input?.taskId === "string" && TASK_ID.test(input.taskId) ? input.taskId : "",
  };
}

async function openDetail(taskId: string): Promise<
  | { kind: "login"; next: string }
  | { kind: "missing" }
  | { kind: "ready"; runtime: Awaited<ReturnType<typeof import("../app/runtime.js").getRuntime>>; taskId: string }
> {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { getRuntime } = await import("../app/runtime.js");
  const { uiSession } = await import("../http/auth.js");
  const runtime = await getRuntime();
  const request = getRequest();
  const next = safeNextPath(taskId ? `/ui/reviews/${taskId}` : "/ui");
  if (uiSession(request, runtime.config.uiToken) !== "ok") return { kind: "login", next };
  if (!taskId) return { kind: "missing" };
  return { kind: "ready", runtime, taskId };
}
