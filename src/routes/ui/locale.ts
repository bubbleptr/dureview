import { createFileRoute } from "@tanstack/react-router";
import { localeSwitchResponse } from "../../http/locale.js";

export const Route = createFileRoute("/ui/locale")({
  server: {
    handlers: {
      GET: ({ request }) => localeSwitchResponse(request),
    },
  },
});
