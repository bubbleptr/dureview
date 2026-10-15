import { reviewResult, type ReviewSummary } from "../review/archive.js";
import type { DureviewService } from "../service.js";
import type { Locale } from "./locale.js";
import { loadDashboard } from "./status.js";
import {
  codexPhrase,
  displayTrigger,
  formatDuration,
  formatTime,
  formatUptime,
  resultLabel,
  reviewDurationMs,
  runningLabel,
} from "./page.js";
import { formIsFiltered, reviewFilterFromSearch, type ReviewFormState } from "./query.js";
import type { ReviewListModel, ReviewRowView } from "./list-model.js";

export type ListContext = {
  service: DureviewService;
  dataDir?: string;
  provider: string;
  modelId: string;
  thinking: string;
  githubApp: boolean;
  githubToken: boolean;
  startedAt: number;
};

/** Build the review list from the open archive. Callers enforce the UI token first. */
export async function buildReviewList(
  ctx: ListContext,
  searchParams: URLSearchParams,
  now = Date.now(),
  locale: Locale = "en",
): Promise<ReviewListModel> {
  const query = reviewFilterFromSearch(searchParams, now);
  const [listed, status] = await Promise.all([
    ctx.service.reviewsForUi(query.filter),
    loadDashboard({
      dataDir: ctx.dataDir,
      provider: ctx.provider,
      model: ctx.modelId,
      githubApp: ctx.githubApp,
      githubToken: ctx.githubToken,
      startedAt: ctx.startedAt,
    }),
  ]);
  return {
    version: status.version,
    uptime: formatUptime(status.uptimeSeconds * 1000),
    provider: status.provider,
    model: status.model,
    thinking: ctx.thinking,
    codex: codexPhrase(status.codex, now, locale),
    githubApp: status.githubApp,
    githubToken: status.githubToken,
    reviews: listed.reviews.map((review) => reviewRow(review, now, locale)),
    repos: listedRepos(listed.repos, query.form.repo),
    total: listed.total,
    shown: listed.reviews.length,
    form: query.form,
    filtered: formIsFiltered(query.form),
    empty: listed.total === 0 ? "none" : listed.reviews.length === 0 ? "filtered" : null,
  };
}

export function searchParamsFrom(search: string): URLSearchParams {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(raw);
}

function reviewRow(review: ReviewSummary, now: number, locale: Locale): ReviewRowView {
  const kind = reviewResult(review);
  const whenIso = review.finishedAt ?? review.startedAt;
  return {
    taskId: review.taskId,
    href: `/ui/reviews/${encodeURIComponent(review.taskId)}`,
    repoLabel: `${review.owner}/${review.repo} #${review.number}`,
    title: review.title || "—",
    triggerLabel: displayTrigger(review.trigger, locale),
    resultKind: kind,
    resultText: resultLabel(kind, locale),
    p0: countText(review.p0, review.countsKnown),
    p1: countText(review.p1, review.countsKnown),
    p2: countText(review.p2, review.countsKnown),
    p3: countText(review.p3, review.countsKnown),
    p0On: review.countsKnown && review.p0 > 0,
    p1On: review.countsKnown && review.p1 > 0,
    p2On: review.countsKnown && review.p2 > 0,
    p3On: review.countsKnown && review.p3 > 0,
    duration: durationText(review, now, locale),
    durationMs: review.outcome === "running" ? null : reviewDurationMs(review.startedAt, review.finishedAt, now),
    whenIso,
    whenLabel: formatTime(whenIso, locale),
    modelLine: reviewModelLine(review),
  };
}

function reviewModelLine(review: ReviewSummary): string | null {
  const name = [review.provider, review.model].filter((part) => part && part.length > 0).join("/");
  if (name && review.thinking) return `${name} · ${review.thinking}`;
  if (name) return name;
  return review.thinking;
}

function durationText(review: ReviewSummary, now: number, locale: Locale): string {
  if (review.outcome === "running") return runningLabel(review.startedAt, now, locale);
  return formatDuration(reviewDurationMs(review.startedAt, review.finishedAt, now));
}

function countText(count: number, known: boolean): string {
  return known ? String(count) : "—";
}

function listedRepos(repos: string[], selected: ReviewFormState["repo"]): string[] {
  const set = new Set(repos);
  if (selected) set.add(selected);
  return [...set].sort((left, right) => left.localeCompare(right));
}
