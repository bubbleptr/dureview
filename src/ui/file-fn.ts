import { createServerFn } from "@tanstack/react-start";

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const getReviewFileContents = createServerFn({ method: "GET" })
  .validator((input: { taskId: string; path: string; previousPath?: string | null }) => ({
    taskId: typeof input?.taskId === "string" && TASK_ID.test(input.taskId) ? input.taskId : "",
    path: typeof input?.path === "string" ? input.path.slice(0, 1024) : "",
    previousPath: typeof input?.previousPath === "string" ? input.previousPath.slice(0, 1024) : null,
  }))
  .handler(async ({ data }): Promise<
    { kind: "files"; oldText: string | null; newText: string | null } | { kind: "unavailable" }
  > => {
    const { getRequest, setResponseStatus } = await import("@tanstack/react-start/server");
    const { getRuntime } = await import("../app/runtime.js");
    const { uiSession } = await import("../http/auth.js");
    const runtime = await getRuntime();
    const request = getRequest();
    if (uiSession(request, runtime.config.uiToken) !== "ok") return { kind: "unavailable" };
    if (!data.taskId || !data.path) return { kind: "unavailable" };
    const loaded = await runtime.service.reviewFileContents(
      data.taskId,
      data.path,
      data.previousPath,
      AbortSignal.timeout(20_000),
    );
    if (loaded.kind === "rejected") {
      setResponseStatus(loaded.status);
      return { kind: "unavailable" };
    }
    return loaded;
  });
