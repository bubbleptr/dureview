import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getRuntime } = await import("../app/runtime.js");
        const { handleWebhookRequest } = await import("../http/webhook.js");
        const runtime = await getRuntime();
        return handleWebhookRequest(runtime.service, runtime.service.configuredWebhookSecret(), request);
      },
    },
  },
});
