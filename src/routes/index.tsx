import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "../components/login-form.js";
import { ReviewListView } from "../components/review-list.js";
import { loadHome } from "../ui/home-data.js";

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
  loader: async ({ location }) => ({ ...(await loadHome(location.searchStr, location.pathname)), search: location.searchStr }),
  head: () => ({ meta: [{ title: "Overview · dureview" }] }),
  component: HomePage,
});

function HomePage() {
  const data = Route.useLoaderData();
  if (data.list.kind === "login") return <LoginForm next={data.list.next} />;
  return <ReviewListView model={data.list.model} search={data.search} week={data.week} day={data.day} />;
}
