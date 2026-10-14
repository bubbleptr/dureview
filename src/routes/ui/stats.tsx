import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "../../components/login-form.js";
import { StatsPage } from "../../components/stats-page.js";
import { getStats } from "../../ui/stats-fn.js";

export const Route = createFileRoute("/ui/stats")({
  server: {
    handlers: {
      GET: async ({ request, next }) => {
        const { guardListGet } = await import("../../http/page-guard.js");
        const blocked = await guardListGet(request);
        if (blocked) return blocked;
        return next();
      },
    },
  },
  loader: ({ location }) => getStats({ data: { search: location.searchStr, next: location.pathname } }),
  component: StatsRoute,
});

function StatsRoute() {
  const data = Route.useLoaderData();
  if (data.kind === "login") return <LoginForm next={data.next} />;
  return <StatsPage model={data.model} />;
}
