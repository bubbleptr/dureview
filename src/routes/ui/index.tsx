import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "../../components/login-form.js";
import { OverviewPage } from "../../components/stats-page.js";
import { getStats } from "../../ui/stats-fn.js";

export const Route = createFileRoute("/ui/")({
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
  loader: async ({ location }) => {
    return getStats({ data: { search: location.searchStr, next: location.pathname } });
  },
  head: () => ({ meta: [{ title: "Overview · dureview" }] }),
  component: OverviewRoute,
});

function OverviewRoute() {
  const data = Route.useLoaderData();
  if (data.kind === "login") return <LoginForm next={data.next} />;
  return <OverviewPage model={data.model} />;
}
