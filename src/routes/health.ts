import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () => {
        const { getRuntime } = await import("../app/runtime.js");
        await getRuntime();
        return Response.json({ ok: true });
      },
    },
  },
});
