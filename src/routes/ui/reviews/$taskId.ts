import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/ui/reviews/$taskId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { getRuntime } = await import("../../../app/runtime.js");
        const { reviewDetailResponse } = await import("../../../http/detail.js");
        const runtime = await getRuntime();
        return reviewDetailResponse({
          service: runtime.service,
          uiToken: runtime.config.uiToken,
          githubApiUrl: runtime.config.githubApiUrl,
          taskId: params.taskId,
          request,
        });
      },
    },
  },
});
