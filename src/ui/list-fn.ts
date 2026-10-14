import { createServerFn } from "@tanstack/react-start";
import { safeNextPath } from "./next-path.js";
import type { ReviewListModel } from "./list-model.js";

export type ListPayload = { kind: "login"; next: string } | { kind: "list"; model: ReviewListModel };

export const getReviewList = createServerFn({ method: "GET" })
  .validator((input: { search: string; next: string }) => ({
    search: typeof input?.search === "string" ? input.search.slice(0, 2000) : "",
    next: safeNextPath(typeof input?.next === "string" ? input.next : "/ui"),
  }))
  .handler(async ({ data }): Promise<ListPayload> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const { getRuntime, listContext } = await import("../app/runtime.js");
    const { uiSession } = await import("../http/auth.js");
    const { buildReviewList, searchParamsFrom } = await import("./list-data.js");
    const runtime = await getRuntime();
    const request = getRequest();
    if (uiSession(request, runtime.config.uiToken) !== "ok") {
      return { kind: "login", next: data.next };
    }
    const model = await buildReviewList(listContext(runtime), searchParamsFrom(data.search));
    return { kind: "list", model };
  });
