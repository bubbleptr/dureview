import type { ReactNode } from "react";
import type { ReviewListModel, ReviewRowView } from "../ui/list-model.js";
import { LocalTime } from "./local-time.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { UiNav } from "./ui-nav.js";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { NativeSelect } from "./ui/native-select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

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

export function ReviewListView({ model }: { model: ReviewListModel }) {
  const count =
    model.total === model.shown ? `${model.shown} shown` : `${model.shown} shown of ${model.total}`;
  return (
    <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>dureview</CardTitle>
            <UiNav current="reviews" />
          </div>
          <StatusLine model={model} />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form className="flex flex-wrap items-end gap-3" method="get" action="/ui">
            <Filter label="Repository">
              <NativeSelect name="repo" defaultValue={model.form.repo}>
                <option value="">All repositories</option>
                {model.repos.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </NativeSelect>
            </Filter>
            <Filter label="Result">
              <NativeSelect name="result" defaultValue={model.form.result}>
                {RESULTS.map(([value, label]) => (
                  <option key={value || "all"} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Filter>
            <Filter label="Time">
              <NativeSelect name="since" defaultValue={model.form.since}>
                {SINCE.map(([value, label]) => (
                  <option key={value || "any"} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </Filter>
            <Filter label="From">
              <Input type="date" name="from" defaultValue={model.form.from} />
            </Filter>
            <Filter label="To">
              <Input type="date" name="to" defaultValue={model.form.to} />
            </Filter>
            <Filter label="Search" className="min-w-48 flex-1">
              <Input type="search" name="q" defaultValue={model.form.q} placeholder="Title, repository, or PR" />
            </Filter>
            <Button type="submit">Apply</Button>
            {model.filtered ? (
              <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/ui">
                Clear
              </a>
            ) : null}
          </form>
          <p className="text-xs text-muted-foreground">{count}</p>
          {model.empty === "none" ? <p className="text-sm text-muted-foreground">No reviews yet.</p> : null}
          {model.empty === "filtered" ? (
            <p className="text-sm text-muted-foreground">No reviews match these filters.</p>
          ) : null}
          {model.reviews.length > 0 ? <ReviewTable rows={model.reviews} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusLine({ model }: { model: ReviewListModel }) {
  return (
    <p className="text-xs text-muted-foreground">
      {model.version}
      {" · "}
      up {model.uptime}
      {" · "}
      {model.provider}/{model.model}
      {" · "}
      {model.thinking}
      {" · "}
      {model.codex.kind === "plain" ? (
        model.codex.text
      ) : (
        <>
          {model.codex.lead}
          <LocalTime iso={model.codex.iso} label={model.codex.label} />
        </>
      )}
      {" · "}
      GitHub App <b>{model.githubApp ? "yes" : "no"}</b>
      {" · "}
      GitHub token <b>{model.githubToken ? "yes" : "no"}</b>
    </p>
  );
}

function Filter({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <Label className={className ? `flex flex-col gap-1 ${className}` : "flex flex-col gap-1"}>
      {label}
      {children}
    </Label>
  );
}

function ReviewTable({ rows }: { rows: ReviewRowView[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Repository</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Result</TableHead>
          <TableHead className="text-right text-red-700">P0</TableHead>
          <TableHead className="text-right text-orange-700">P1</TableHead>
          <TableHead className="text-right text-amber-700">P2</TableHead>
          <TableHead className="text-right">P3</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.taskId}>
            <TableCell>
              <a className="font-medium underline-offset-4 hover:underline" href={row.href}>
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
            <Count cell={row.p0} on={row.p0On} tone="text-red-700" />
            <Count cell={row.p1} on={row.p1On} tone="text-orange-700" />
            <Count cell={row.p2} on={row.p2On} tone="text-amber-700" />
            <Count cell={row.p3} on={row.p3On} tone="text-muted-foreground" />
            <TableCell className="text-right tabular-nums">{row.duration}</TableCell>
            <TableCell className="text-muted-foreground">
              {row.whenLabel ? <LocalTime iso={row.whenIso} label={row.whenLabel} /> : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Count({ cell, on, tone }: { cell: string; on: boolean; tone: string }) {
  return <TableCell className={on ? `text-right tabular-nums ${tone}` : "text-right tabular-nums"}>{cell}</TableCell>;
}
