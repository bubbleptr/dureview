import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "../../../components/login-form.js";
import { ReviewListView } from "../../../components/review-list.js";
import { getReviewList } from "../../../ui/list-fn.js";
import { localeFromMatches } from "../../../ui/locale.js";
import { messages } from "../../../ui/messages.js";

export const Route = createFileRoute("/ui/reviews/")({
  server: {
    handlers: {
      GET: async ({ request, next }) => {
        const { guardListGet } = await import("../../../http/page-guard.js");
        const blocked = await guardListGet(request);
        if (blocked) return blocked;
        return next();
      },
    },
  },
  loader: async ({ location }) => {
    const list = await getReviewList({ data: { search: location.searchStr, next: location.pathname } });
    return { list, search: location.searchStr };
  },
  head: ({ matches }) => ({ meta: [{ title: messages[localeFromMatches(matches)].reviews.documentTitle }] }),
  component: ReviewsPage,
});

function ReviewsPage() {
  const data = Route.useLoaderData();
  if (data.list.kind === "login") return <LoginForm next={data.list.next} />;
  return <ReviewListView model={data.list.model} search={data.search} />;
}
