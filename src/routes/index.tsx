import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "../components/login-form.js";
import { OverviewPage } from "../components/stats-page.js";
import { getShellStatus } from "../ui/shell-fn.js";
import { getStats } from "../ui/stats-fn.js";

export const Route = createFileRoute("/")({
  server: {
    handlers: {
      GET: async ({ request, next }) => {
        const { guardListGet } = await import("../http/page-guard.js");
        const blocked = await guardListGet(request);
        if (blocked) return blocked;
        return next();
      },
    },
  },
  loader: async ({ location }) => {
    const data = await getStats({ data: { search: location.searchStr, next: location.pathname } });
    if (data.kind !== "stats") return { ...data, status: null };
    return { ...data, status: await getShellStatus() };
  },
  head: () => ({ meta: [{ title: "Overview · dureview" }] }),
  component: HomePage,
});

function HomePage() {
  const data = Route.useLoaderData();
  if (data.kind === "login") return <LoginForm next={data.next} />;
  return <OverviewPage model={data.model} status={data.status} />;
}
