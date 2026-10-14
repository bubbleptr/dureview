import { createServerFn } from "@tanstack/react-start";
import { safeNextPath } from "./next-path.js";
import type { StatsPageModel } from "./stats-model.js";

export type StatsPayload = { kind: "login"; next: string } | { kind: "stats"; model: StatsPageModel };

export const getStats = createServerFn({ method: "GET" })
  .validator((input: { search: string; next: string }) => ({
    search: typeof input?.search === "string" ? input.search.slice(0, 2000) : "",
    next: safeNextPath(typeof input?.next === "string" ? input.next : "/ui/stats"),
  }))
  .handler(async ({ data }): Promise<StatsPayload> => {
    const { getRequest } = await import("@tanstack/react-start/server");
    const { getRuntime } = await import("../app/runtime.js");
    const { uiSession } = await import("../http/auth.js");
    const { buildStatsPage } = await import("./stats-data.js");
    const { searchParamsFrom } = await import("./list-data.js");
    const runtime = await getRuntime();
    const request = getRequest();
    if (uiSession(request, runtime.config.uiToken) !== "ok") {
      return { kind: "login", next: data.next };
    }
    const model = await buildStatsPage(runtime.service, searchParamsFrom(data.search));
    return { kind: "stats", model };
  });
