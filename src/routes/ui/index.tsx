import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "../../components/login-form.js";
import { ReviewListView } from "../../components/review-list.js";
import { getReviewList } from "../../ui/list-fn.js";

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
  loader: ({ location }) => getReviewList({ data: { search: location.searchStr, next: location.pathname } }),
  component: ReviewListPage,
});

function ReviewListPage() {
  const data = Route.useLoaderData();
  if (data.kind === "login") return <LoginForm next={data.next} />;
  return <ReviewListView model={data.model} />;
}
