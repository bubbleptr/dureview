import { createFileRoute, redirect } from "@tanstack/react-router";
import { redirectResponse } from "../../http/headers.js";

export const Route = createFileRoute("/ui/stats")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const url = new URL(request.url);
        return redirectResponse(`/ui${url.search}`);
      },
    },
  },
  beforeLoad: ({ location }) => {
    throw redirect({ href: `/ui${location.searchStr}` });
  },
});
