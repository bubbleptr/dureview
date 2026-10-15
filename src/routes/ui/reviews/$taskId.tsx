import { Suspense } from "react";
import { Await, createFileRoute, notFound } from "@tanstack/react-router";
import { LoginForm } from "../../../components/login-form.js";
import {
  ReviewDetailPending,
  ReviewDetailUnavailable,
  ReviewDetailView,
} from "../../../components/review-detail.js";
import { getReviewDetail, getReviewHeader } from "../../../ui/detail-fn.js";
import type { DetailPayload } from "../../../ui/detail-data.js";

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
    const header = await getReviewHeader({ data: { taskId: params.taskId } });
    if (header.kind === "missing") throw notFound();
    if (header.kind === "login") return header;
    const detail: Promise<DetailPayload> = getReviewDetail({ data: { taskId: params.taskId } }).catch(() => ({
      kind: "error",
    }));
    return { kind: "detail" as const, header: header.header, detail };
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.kind === "detail" ? loaderData.header.pageTitle : "登录 · dureview" }],
  }),
  component: ReviewDetailPage,
});

function ReviewDetailPage() {
  const data = Route.useLoaderData();
  if (data.kind === "login") return <LoginForm next={data.next} />;
  return (
    <Suspense fallback={<ReviewDetailPending header={data.header} />}>
      <Await promise={data.detail}>
        {(detail) => {
          if (detail.kind === "detail") {
            return <ReviewDetailView model={detail.model} tree={detail.tree} />;
          }
          if (detail.kind === "login") return <LoginForm next={detail.next} />;
          const message =
            detail.kind === "missing" ? "This review is no longer available." : "The review could not be loaded.";
          return <ReviewDetailUnavailable header={data.header} message={message} />;
        }}
      </Await>
    </Suspense>
  );
}
