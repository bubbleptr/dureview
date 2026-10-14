import { createFileRoute, notFound } from "@tanstack/react-router";
import { LoginForm } from "../../../components/login-form.js";
import { ReviewDetailView } from "../../../components/review-detail.js";
import { getReviewDetail } from "../../../ui/detail-fn.js";
import { getShellStatus } from "../../../ui/shell-fn.js";

export const Route = createFileRoute("/ui/reviews/$taskId")({
  server: {
    handlers: {
      GET: async ({ request, params, next }) => {
        const { guardDetailGet } = await import("../../../http/page-guard.js");
        const blocked = await guardDetailGet(request, params.taskId);
        if (blocked) return blocked;
        return next();
      },
    },
  },
  loader: async ({ params }) => {
    const data = await getReviewDetail({ data: { taskId: params.taskId } });
    if (data.kind === "missing") throw notFound();
    const status = data.kind === "detail" ? await getShellStatus() : null;
    return { ...data, status };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.kind === "detail" ? loaderData.model.pageTitle : "登录 · dureview" }],
  }),
  component: ReviewDetailPage,
});

function ReviewDetailPage() {
  const data = Route.useLoaderData();
  const { taskId } = Route.useParams();
  if (data.kind === "login") return <LoginForm next={data.next} />;
  return <ReviewDetailView model={data.model} presentation={data.presentation} taskId={taskId} status={data.status} />;
}
