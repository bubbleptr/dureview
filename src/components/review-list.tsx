import type { ReactNode } from "react";
import type { ReviewListModel, ReviewRowView } from "../ui/list-model.js";
import { compareReviewRows } from "../ui/list-sort.js";
import { AppShell, type ShellStatus } from "./app-shell.js";
import { LocalTime } from "./local-time.js";
import { Badge } from "./ui/badge.js";
import { Button, buttonVariants } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { NativeSelect } from "./ui/native-select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

const PAGE_SIZE = 10;

const RESULTS: Array<[string, string]> = [
  ["", "All results"],
  ["pass", "Pass"],
  ["suggest", "Suggestions"],
  ["blocker", "P0/P1"],
  ["error", "Error"],
  ["running", "Running"],
];

const SINCE: Array<[string, string]> = [
  ["", "Any time"],
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
];

const SORT_KEYS = ["repo", "title", "trigger", "result", "p0", "p1", "p2", "p3", "duration", "when"] as const;
type SortKey = (typeof SORT_KEYS)[number];

export function ReviewListView({ model, search = "" }: { model: ReviewListModel; search?: string }) {
  const status: ShellStatus = {
    version: model.version,
    uptime: model.uptime,
    provider: model.provider,
    model: model.model,
    thinking: model.thinking,
    codex: model.codex,
    githubApp: model.githubApp,
    githubToken: model.githubToken,
  };
  const view = pageRows(model.reviews, search);
  const count = model.total === model.shown ? `${model.shown} shown` : `${model.shown} shown of ${model.total}`;
  return (
    <AppShell current="reviews" title="Reviews" status={status} form={{ method: "get", action: "/ui/reviews" }}>
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">Latest reviews. Open a row for the diff.</p>
          <p className="text-xs text-muted-foreground tabular-nums">{count}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-b pb-4">
            <Filter label="Repository">
              <NativeSelect name="repo" defaultValue={model.form.repo} className="h-8 w-44 text-xs" onChange={submitForm}>
                <option value="">All repositories</option>
                {model.repos.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </NativeSelect>
            </Filter>
            <Filter label="Time">
              <NativeSelect name="since" defaultValue={model.form.since} className="h-8 text-xs" onChange={submitForm}>
                {SINCE.map(([value, label]) => (
                  <option key={value || "any"} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Filter>
            <Filter label="Result">
              <NativeSelect name="result" defaultValue={model.form.result} className="h-8 text-xs" onChange={submitForm}>
                {RESULTS.map(([value, label]) => (
                  <option key={value || "all"} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Filter>
            <Filter label="From">
              <Input type="date" name="from" defaultValue={model.form.from} className="h-8 w-36 text-xs" onChange={submitForm} />
            </Filter>
            <Filter label="To">
              <Input type="date" name="to" defaultValue={model.form.to} className="h-8 w-36 text-xs" onChange={submitForm} />
            </Filter>
            <Filter label="Search" className="min-w-48 flex-1">
              <Input type="search" name="q" defaultValue={model.form.q} placeholder="Title, repository, or PR" className="h-8 text-xs" />
            </Filter>
            <Button type="submit" size="sm">
              Apply
            </Button>
            {model.filtered ? (
              <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/ui/reviews">
                Clear
              </a>
            ) : null}
        </div>
        {model.empty === "none" ? <p className="text-sm text-muted-foreground">No reviews yet.</p> : null}
        {model.empty === "filtered" ? <p className="text-sm text-muted-foreground">No reviews match these filters.</p> : null}
        {model.reviews.length > 0 ? (
          <>
            <ReviewTable rows={view.rows} search={search} sort={view.sort} dir={view.dir} count={count} />
              {view.pages > 1 ? (
                <div className="flex items-center justify-end gap-2 text-xs">
                  {view.page > 1 ? (
                    <a className={buttonVariants({ variant: "outline", size: "sm" })} href={listHref(search, { page: view.page === 2 ? null : String(view.page - 1) })}>
                      Previous
                    </a>
                  ) : (
                    <span className="px-3 text-muted-foreground">Previous</span>
                  )}
                  <span className="tabular-nums text-muted-foreground">
                    Page {view.page} of {view.pages}
                  </span>
                  {view.page < view.pages ? (
                    <a className={buttonVariants({ variant: "outline", size: "sm" })} href={listHref(search, { page: String(view.page + 1) })}>
                      Next
                    </a>
                  ) : (
                    <span className="px-3 text-muted-foreground">Next</span>
                  )}
                </div>
              ) : null}
          </>
        ) : null}
      </section>
    </AppShell>
  );
}

function submitForm(event: { currentTarget: { form: HTMLFormElement | null } }): void {
  event.currentTarget.form?.requestSubmit();
}

function Filter({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return <Label className={className ? `flex flex-col gap-1 ${className}` : "flex flex-col gap-1"}>{label}{children}</Label>;
}

function ReviewTable({
  rows,
  search,
  sort,
  dir,
  count,
}: {
  rows: ReviewRowView[];
  search: string;
  sort: string;
  dir: "asc" | "desc";
  count: string;
}) {
  return (
    <Table>
      <caption className="sr-only">Reviews, {count}</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <SortHead label="Repository" sortKey="repo" search={search} sort={sort} dir={dir} />
          <SortHead label="Title" sortKey="title" search={search} sort={sort} dir={dir} />
          <SortHead label="Trigger" sortKey="trigger" search={search} sort={sort} dir={dir} />
          <SortHead label="Result" sortKey="result" search={search} sort={sort} dir={dir} />
          <SortHead label="P0" sortKey="p0" search={search} sort={sort} dir={dir} align="right" className="text-red-700 dark:text-red-400" />
          <SortHead label="P1" sortKey="p1" search={search} sort={sort} dir={dir} align="right" className="text-orange-700 dark:text-orange-400" />
          <SortHead label="P2" sortKey="p2" search={search} sort={sort} dir={dir} align="right" className="text-amber-700 dark:text-amber-400" />
          <SortHead label="P3" sortKey="p3" search={search} sort={sort} dir={dir} align="right" />
          <SortHead label="Duration" sortKey="duration" search={search} sort={sort} dir={dir} align="right" />
          <SortHead label="When" sortKey="when" search={search} sort={sort} dir={dir} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.taskId}
            className="cursor-pointer"
            onClick={(event) => {
              if (!(event.target instanceof Element) || event.target.closest("a")) return;
              window.location.href = row.href;
            }}
          >
            <TableCell>
              <a className="font-mono text-xs font-medium underline-offset-4 hover:underline" href={row.href}>
                {row.repoLabel}
              </a>
            </TableCell>
            <TableCell className="max-w-xs whitespace-normal">
              <div>{row.title}</div>
              {row.modelLine ? <p className="text-xs text-muted-foreground">{row.modelLine}</p> : null}
            </TableCell>
            <TableCell>
              <span>{row.triggerLabel}</span>
            </TableCell>
            <TableCell>
              <Badge variant={row.resultKind}>{row.resultText}</Badge>
            </TableCell>
            <Count cell={row.p0} on={row.p0On} tone="text-red-700 dark:text-red-400" />
            <Count cell={row.p1} on={row.p1On} tone="text-orange-700 dark:text-orange-400" />
            <Count cell={row.p2} on={row.p2On} tone="text-amber-700 dark:text-amber-400" />
            <Count cell={row.p3} on={row.p3On} tone="text-muted-foreground" />
            <TableCell className="text-right text-xs tabular-nums">{row.duration}</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {row.whenLabel ? <LocalTime iso={row.whenIso} label={row.whenLabel} /> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SortHead({
  label,
  sortKey,
  search,
  sort,
  dir,
  align,
  className,
}: {
  label: string;
  sortKey: SortKey;
  search: string;
  sort: string;
  dir: "asc" | "desc";
  align?: "right";
  className?: string;
}) {
  const active = sort === sortKey;
  const mark = active ? (dir === "asc" ? " ↑" : " ↓") : "";
  return (
    <TableHead scope="col" className={`${align === "right" ? "text-right" : ""} ${className ?? ""}`} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <a className="inline-flex items-center gap-0.5 hover:text-foreground" href={sortHref(search, sortKey, sort, dir)}>
        {label}
        {mark ? <span aria-hidden="true">{mark}</span> : null}
      </a>
    </TableHead>
  );
}

function Count({ cell, on, tone }: { cell: string; on: boolean; tone: string }) {
  return <TableCell className={on ? `text-right text-xs tabular-nums ${tone}` : "text-right text-xs tabular-nums"}>{cell}</TableCell>;
}

function pageRows(rows: ReviewRowView[], search: string): { rows: ReviewRowView[]; page: number; pages: number; sort: string; dir: "asc" | "desc" } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const requested = params.get("sort") ?? "";
  const sort = SORT_KEYS.includes(requested as SortKey) ? requested : "";
  const dir = params.get("dir") === "asc" ? "asc" : "desc";
  const sorted = sort ? [...rows].sort((left, right) => compareRows(left, right, sort, dir)) : rows;
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const rawPage = Number(params.get("page"));
  const page = Number.isInteger(rawPage) && rawPage > 0 ? Math.min(pages, rawPage) : 1;
  const start = (page - 1) * PAGE_SIZE;
  return { rows: sorted.slice(start, start + PAGE_SIZE), page, pages, sort, dir };
}

function compareRows(left: ReviewRowView, right: ReviewRowView, sort: string, dir: "asc" | "desc"): number {
  return compareReviewRows(left, right, sort, dir);
}

function sortHref(search: string, key: SortKey, active: string, dir: "asc" | "desc"): string {
  const next = active === key ? (dir === "asc" ? "desc" : "asc") : key === "repo" || key === "title" || key === "trigger" || key === "result" ? "asc" : "desc";
  return listHref(search, { sort: key, dir: next, page: null });
}

function listHref(search: string, updates: Record<string, string | null>): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const [key, value] of Object.entries(updates)) {
    if (!value) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `/ui/reviews?${query}` : "/ui/reviews";
}
