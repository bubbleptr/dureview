import { Fragment, useCallback, useState, type ReactNode } from "react";
import type { FileDiffLoadedFiles, FileDiffMetadata } from "@pierre/diffs";
import { FileDiff, type DiffLineAnnotation } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type {
  DetailCommentView,
  DetailFileView,
  DetailLineView,
  DetailSettings,
  DetailSummary,
  ReviewDetailModel,
} from "../ui/detail-model.js";
import { toDiffFiles } from "../ui/diff-files.js";
import {
  REVIEW_DIFF_THEME,
  REVIEW_EXPAND_CSS,
  parseReviewPatch,
  reviewAnnotations,
  reviewTreeOptions,
  type ReviewPresentation,
} from "../ui/review-presentation.js";
import { LocalTime } from "./local-time.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";

const PRIORITY_BADGE = [
  "border-transparent bg-red-50 text-red-700",
  "border-transparent bg-orange-50 text-orange-800",
  "border-transparent bg-amber-50 text-amber-800",
  "border-transparent bg-muted text-muted-foreground",
] as const;

const PRIORITY_BORDER = [
  "border-l-red-600",
  "border-l-orange-700",
  "border-l-amber-600",
  "border-l-muted-foreground",
] as const;

const PRIORITY_SURFACE = ["bg-red-50/80", "bg-orange-50/70", "bg-amber-50/70", "bg-muted/50"] as const;

const SEVERITY = [
  "shadow-[inset_2px_0_0_#cf222e]",
  "shadow-[inset_2px_0_0_#bc4c00]",
  "shadow-[inset_2px_0_0_#9a6700]",
  "shadow-[inset_2px_0_0_#57606a]",
] as const;

const COUNT_TONE: Record<string, string> = {
  P0: "text-red-700",
  P1: "text-orange-800",
  P2: "text-amber-700",
  P3: "text-muted-foreground",
};

export function ReviewDetailView({
  model,
  presentation,
  taskId,
}: {
  model: ReviewDetailModel;
  presentation?: ReviewPresentation;
  taskId?: string;
}) {
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
        <Button variant="outline" size="sm" asChild>
          <a href={model.backHref}>Reviews</a>
        </Button>
        <a className="text-sm text-muted-foreground underline-offset-4 hover:underline" href="/ui/settings">
          Settings
        </a>
        {model.pullHref ? (
          <a className="font-semibold underline-offset-4 hover:underline" href={model.pullHref} rel="noreferrer">
            {model.pullLabel}
          </a>
        ) : (
          <span className="font-semibold">{model.pullLabel}</span>
        )}
        <h1 className="order-last w-full min-w-0 truncate text-sm font-medium min-[960px]:order-none min-[960px]:flex-1">
          {model.heading}
        </h1>
        <Badge variant={model.resultKind}>{model.resultText}</Badge>
        <Badge variant="outline">{model.triggerLabel}</Badge>
        <span className="text-sm text-muted-foreground">{model.duration}</span>
        {model.whenLabel ? (
          <span className="text-sm text-muted-foreground">
            <LocalTime iso={model.whenIso} label={model.whenLabel} />
          </span>
        ) : null}
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 min-[960px]:grid-cols-[220px_minmax(0,1fr)_380px]">
        <aside className="flex min-h-0 flex-col overflow-hidden border-b min-[960px]:border-r min-[960px]:border-b-0">
          <p className="px-3 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Files</p>
          <div className="min-h-48 flex-1">
            {model.files.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">No changed files.</p>
            ) : (
              <ReviewTree files={model.files} preloaded={presentation?.tree ?? null} />
            )}
          </div>
          {model.hiddenFiles > 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{model.hiddenFiles} more files are not shown.</p>
          ) : null}
        </aside>
        <main className="min-h-0 overflow-auto border-b min-[960px]:border-r min-[960px]:border-b-0">
          <DiffColumn model={model} presentation={presentation} taskId={taskId} />
        </main>
        <aside className="min-h-0 overflow-x-hidden overflow-y-auto">
          <SummaryRail summary={model.summary} />
          <SettingsRail settings={model.settings} />
        </aside>
      </div>
    </div>
  );
}

function ReviewTree({
  files,
  preloaded,
}: {
  files: DetailFileView[];
  preloaded: ReviewPresentation["tree"];
}) {
  const { model } = useFileTree(
    reviewTreeOptions(files, (selected) => {
      if (typeof window === "undefined") return;
      const path = selected[0];
      if (!path) return;
      const file = files.find((item) => item.filename === path);
      if (!file) return;
      window.location.hash = file.anchor;
    }),
  );
  return (
    <FileTree
      model={model}
      preloadedData={preloaded ?? undefined}
      className="h-full min-h-48"
      style={{ height: "100%", minHeight: "12rem" }}
    />
  );
}

function DiffColumn({
  model,
  presentation,
  taskId,
}: {
  model: ReviewDetailModel;
  presentation?: ReviewPresentation;
  taskId?: string;
}) {
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const loadDiffFiles = useLoadDiffFiles(taskId);
  const highlighted = model.files.some((file) => file.diffText != null && parseReviewPatch(file.diffText) != null);
  return (
    <div>
      {model.diffUnavailable ? (
        <p className="border-b px-3 py-2 text-sm text-muted-foreground">
          The diff could not be loaded from GitHub. Saved comments are still listed.
        </p>
      ) : null}
      {model.hiddenFiles > 0 ? (
        <p className="border-b px-3 py-2 text-sm text-muted-foreground">{model.hiddenFiles} files are hidden on this page.</p>
      ) : null}
      {highlighted ? (
        <div className="sticky top-0 z-10 flex items-center justify-end gap-1 border-b bg-background px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant={diffStyle === "unified" ? "default" : "outline"}
            aria-pressed={diffStyle === "unified"}
            onClick={() => setDiffStyle("unified")}
          >
            Unified
          </Button>
          <Button
            type="button"
            size="sm"
            variant={diffStyle === "split" ? "default" : "outline"}
            aria-pressed={diffStyle === "split"}
            onClick={() => setDiffStyle("split")}
          >
            Split
          </Button>
        </div>
      ) : null}
      {model.noChangedFiles ? (
        <p className="px-3 py-4 text-sm text-muted-foreground">GitHub returned no changed files.</p>
      ) : null}
      {model.files.map((file) => (
        <FileSection
          key={file.anchor}
          file={file}
          diffStyle={diffStyle}
          loadDiffFiles={taskId ? loadDiffFiles : undefined}
          prerenderedHTML={diffStyle === "unified" ? presentation?.diffs[file.anchor] : undefined}
        />
      ))}
      <CommentGroup title={model.outsideTitle} comments={model.outside} />
    </div>
  );
}

function useLoadDiffFiles(taskId: string | undefined) {
  return useCallback(
    async (fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      if (!taskId) throw new Error("file contents unavailable");
      const { getReviewFileContents } = await import("../ui/file-fn.js");
      const result = await getReviewFileContents({
        data: { taskId, path: fileDiff.name, previousPath: fileDiff.prevName ?? null },
      });
      if (result.kind !== "files") throw new Error("file contents unavailable");
      const files = toDiffFiles(fileDiff, result);
      if (!files) throw new Error("file contents unavailable");
      return files;
    },
    [taskId],
  );
}

function FileSection({
  file,
  diffStyle,
  loadDiffFiles,
  prerenderedHTML,
}: {
  file: DetailFileView;
  diffStyle: "unified" | "split";
  loadDiffFiles?: (fileDiff: FileDiffMetadata) => Promise<FileDiffLoadedFiles>;
  prerenderedHTML?: string;
}) {
  const parsed = file.diffText ? parseReviewPatch(file.diffText) : null;
  const annotations = reviewAnnotations(file);
  return (
    <section id={file.anchor} className="scroll-mt-12 border-b target:bg-muted/40">
      {parsed && file.diffText ? (
        <FileDiff
          fileDiff={parsed}
          options={{ diffStyle, themeType: REVIEW_DIFF_THEME, unsafeCSS: REVIEW_EXPAND_CSS, loadDiffFiles }}
          lineAnnotations={annotations}
          prerenderedHTML={prerenderedHTML}
          disableWorkerPool
          renderAnnotation={renderFinding}
          renderHeaderFilenameSuffix={() => (
            <Badge variant="outline" className="ml-2">
              {file.status}
            </Badge>
          )}
          renderHeaderMetadata={() =>
            file.stats ? <span className="text-sm text-muted-foreground">{file.stats}</span> : null
          }
        />
      ) : (
        <PlainFile file={file} />
      )}
      {file.patchTruncated ? <p className="px-3 py-2 text-sm text-muted-foreground">Patch truncated.</p> : null}
      <CommentGroup title="Not on a line in this diff" comments={file.unanchored} />
    </section>
  );
}

function renderFinding(annotation: DiffLineAnnotation<DetailCommentView>): ReactNode {
  return <CommentCard comment={annotation.metadata} inset />;
}

function PlainFile({ file }: { file: DetailFileView }) {
  return (
    <>
      <header className="sticky top-0 flex items-center gap-2 border-b bg-background px-3 py-2">
        <span className="font-semibold">{file.filename}</span>
        <Badge variant="outline">{file.status}</Badge>
        {file.stats ? <span className="text-sm text-muted-foreground">{file.stats}</span> : null}
      </header>
      {file.patchMissing ? (
        <p className="px-3 py-2 text-sm text-muted-foreground">GitHub did not include a patch for this file.</p>
      ) : (
        <div className="font-mono text-xs leading-5">
          {file.lines.map((line, index) => (
            <DiffLine key={`${file.anchor}-${index}`} line={line} />
          ))}
        </div>
      )}
    </>
  );
}

function DiffLine({ line }: { line: DetailLineView }) {
  if (line.kind === "hunk") {
    return <div className="bg-muted px-3 py-0.5 text-muted-foreground">{line.text}</div>;
  }
  const tone = line.severity === null ? "" : (SEVERITY[line.severity] ?? "");
  return (
    <>
      <div className={`grid grid-cols-[3rem_3rem_1rem_minmax(0,1fr)] gap-1 pr-3 ${tone}`}>
        <span className="text-right text-muted-foreground">{line.oldLabel}</span>
        <span className="text-right text-muted-foreground">{line.newLabel}</span>
        <span className="text-muted-foreground">{line.mark}</span>
        <code className="break-all whitespace-pre-wrap">{line.text}</code>
      </div>
      {line.comments.map((comment) => (
        <CommentCard key={comment.ordinal} comment={comment} inset />
      ))}
    </>
  );
}

function CommentGroup({ title, comments }: { title: string; comments: DetailCommentView[] }) {
  if (comments.length === 0) return null;
  return (
    <div className="py-2">
      <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>
      {comments.map((comment) => (
        <CommentCard key={comment.ordinal} comment={comment} />
      ))}
    </div>
  );
}

function CommentCard({ comment, inset }: { comment: DetailCommentView; inset?: boolean }) {
  const surface = inset ? (PRIORITY_SURFACE[comment.priority] ?? PRIORITY_SURFACE[3]) : "";
  return (
    <article
      id={comment.anchor}
      className={`my-2 rounded-lg border border-l-2 p-3 ${inset ? "mr-3 ml-16" : "mx-3"} ${PRIORITY_BORDER[comment.priority] ?? PRIORITY_BORDER[3]} ${surface}`}
    >
      <header className="mb-1 flex flex-wrap items-center gap-1.5">
        <Badge className={PRIORITY_BADGE[comment.priority] ?? PRIORITY_BADGE[3]}>P{comment.priority}</Badge>
        {comment.tags.map((tag) => (
          <Badge key={tag} variant="outline">
            {tag}
          </Badge>
        ))}
        <span className="text-xs text-muted-foreground">{comment.confidence}</span>
      </header>
      <h3 className="text-sm font-semibold">{comment.title}</h3>
      <p className="mt-1 text-sm">{comment.body}</p>
      {comment.trigger ? (
        <p className="mt-1 text-sm">
          <span className="mr-1 text-muted-foreground">Trigger</span>
          {comment.trigger}
        </p>
      ) : null}
      {comment.evidence.length > 0 ? (
        <p className="mt-1 text-sm">
          {comment.evidence.map((item) => (
            <span key={item} className="block">
              {item}
            </span>
          ))}
        </p>
      ) : null}
      {comment.suggestion ? (
        <pre className="mt-2 overflow-x-auto rounded-md border bg-background p-2 font-mono text-xs whitespace-pre-wrap">
          {comment.suggestion}
        </pre>
      ) : null}
    </article>
  );
}

function SummaryRail({ summary }: { summary: DetailSummary }) {
  return (
    <section className="border-b px-3 py-3">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Summary</h2>
      <Badge variant={summary.resultKind}>{summary.resultText}</Badge>
      {summary.mode === "incomplete" ? (
        <p className="mt-2 text-sm break-words whitespace-pre-wrap">{summary.note}</p>
      ) : (
        <CompleteSummary summary={summary} />
      )}
    </section>
  );
}

function CompleteSummary({ summary }: { summary: Extract<DetailSummary, { mode: "complete" }> }) {
  return (
    <>
      {summary.verdictLabel ? (
        <p className={`mt-2 text-sm font-medium ${verdictTone(summary.verdictKind)}`}>{summary.verdictLabel}</p>
      ) : null}
      {summary.reason ? <p className="mt-1 text-sm">{summary.reason}</p> : null}
      <dl className="mt-3 grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-sm">
        {summary.counts.map((count) => (
          <Fragment key={count.label}>
            <dt className={COUNT_TONE[count.label]}>{count.label}</dt>
            <dd className={count.on ? `tabular-nums ${COUNT_TONE[count.label]}` : "tabular-nums"}>{count.value}</dd>
          </Fragment>
        ))}
      </dl>
      {summary.noComments ? <p className="mt-3 text-sm text-muted-foreground">No saved comments.</p> : null}
      {summary.findings.length > 0 ? (
        <ul className="-mx-3 mt-3">
          {summary.findings.map((finding) => (
            <li key={finding.anchor} className="border-t">
              <a className="flex flex-wrap items-baseline gap-1.5 px-3 py-1.5 text-sm hover:bg-muted/50" href={`#${finding.anchor}`}>
                <Badge className={PRIORITY_BADGE[finding.priority] ?? PRIORITY_BADGE[3]}>P{finding.priority}</Badge>
                <span>{finding.title}</span>
                <span className="text-xs text-muted-foreground">{finding.where}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.checked.length > 0 ? (
        <ul className="mt-3 text-sm text-muted-foreground">
          {summary.checked.map((item, index) => (
            <li key={`${item}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function SettingsRail({ settings }: { settings: DetailSettings }) {
  return (
    <section className="px-3 py-3">
      <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Settings</h2>
      {settings.recorded ? (
        <dl className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-sm">
          {settings.rows.map((row) => (
            <Fragment key={row.key}>
              <dt className="text-muted-foreground">{row.key}</dt>
              <dd className="min-w-0 truncate" title={row.value}>
                {row.value}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Settings were not recorded for this review.</p>
      )}
    </section>
  );
}

function verdictTone(kind: "pass" | "suggest" | "blocker" | null): string {
  if (kind === "blocker") return "text-red-700";
  if (kind === "suggest") return "text-amber-800";
  if (kind === "pass") return "text-green-800";
  return "";
}
