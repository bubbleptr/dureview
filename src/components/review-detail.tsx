import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import {
  commentAnchorIndexes,
  focusSegments,
  gapKey,
  orderCommentedFirst,
  sliceLines,
  windowDiffText,
  type FocusSegment,
} from "../ui/diff-focus.js";
import {
  parseReviewPatch,
  reviewAnnotations,
  reviewDiffOptions,
  reviewFindingCount,
  reviewTreeOptions,
  type ReviewPresentation,
} from "../ui/review-presentation.js";
import { dragLimit, fitPanelWidths, SUMMARY_LIMIT, TREE_LIMIT } from "../ui/panel-widths.js";
import { AppShell, type ShellStatus } from "./app-shell.js";
import { useDiffStyle } from "./diff-style.js";
import { LocalTime } from "./local-time.js";
import { Badge } from "./ui/badge.js";

const PRIORITY_BADGE = [
  "border-transparent bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300",
  "border-transparent bg-orange-50 text-orange-800 dark:bg-orange-400/10 dark:text-orange-300",
  "border-transparent bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-300",
  "border-transparent bg-muted text-muted-foreground",
] as const;

const COMMENT_ACCENT = [
  "border-l-red-700 bg-red-50 dark:border-l-red-300 dark:bg-red-400/10",
  "border-l-orange-700 bg-orange-50 dark:border-l-orange-300 dark:bg-orange-400/10",
  "border-l-amber-700 bg-amber-50 dark:border-l-amber-300 dark:bg-amber-400/10",
  "border-l-neutral-500 bg-muted/70 dark:border-l-neutral-400 dark:bg-muted/40",
] as const;

const LINE_BOX = [
  "bg-red-50 shadow-[inset_3px_0_0_#b91c1c,inset_0_1px_0_#b91c1c,inset_0_-1px_0_#b91c1c] dark:bg-red-400/10 dark:shadow-[inset_3px_0_0_#fca5a5,inset_0_1px_0_#fca5a5,inset_0_-1px_0_#fca5a5]",
  "bg-orange-50 shadow-[inset_3px_0_0_#c2410c,inset_0_1px_0_#c2410c,inset_0_-1px_0_#c2410c] dark:bg-orange-400/10 dark:shadow-[inset_3px_0_0_#fdba74,inset_0_1px_0_#fdba74,inset_0_-1px_0_#fdba74]",
  "bg-amber-50 shadow-[inset_3px_0_0_#a16207,inset_0_1px_0_#a16207,inset_0_-1px_0_#a16207] dark:bg-amber-400/10 dark:shadow-[inset_3px_0_0_#fcd34d,inset_0_1px_0_#fcd34d,inset_0_-1px_0_#fcd34d]",
  "bg-muted/70 shadow-[inset_3px_0_0_#525252,inset_0_1px_0_#525252,inset_0_-1px_0_#525252] dark:bg-muted/40 dark:shadow-[inset_3px_0_0_#a3a3a3,inset_0_1px_0_#a3a3a3,inset_0_-1px_0_#a3a3a3]",
] as const;

const COUNT_TONE: Record<string, string> = {
  P0: "text-red-700 dark:text-red-300",
  P1: "text-orange-800 dark:text-orange-300",
  P2: "text-amber-700 dark:text-amber-300",
  P3: "text-muted-foreground",
};

const TREE_WIDTH_KEY = "dureview-tree-width";
const SUMMARY_WIDTH_KEY = "dureview-summary-width";

export function ReviewDetailView({
  model,
  presentation,
  status = null,
}: {
  model: ReviewDetailModel;
  presentation?: ReviewPresentation;
  taskId?: string;
  status?: ShellStatus | null;
}) {
  const [diffStyle] = useDiffStyle();
  const [treePref, setTreePref] = useStoredWidth(TREE_WIDTH_KEY, TREE_LIMIT.fallback, TREE_LIMIT.max);
  const [summaryPref, setSummaryPref] = useStoredWidth(SUMMARY_WIDTH_KEY, SUMMARY_LIMIT.fallback, SUMMARY_LIMIT.max);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  useEffect(() => {
    const node = columnsRef.current;
    if (!node) return;
    const measure = () => setContainerWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const shown = fitPanelWidths(treePref, summaryPref, containerWidth);
  const treeDrag = dragLimit(shown.summary, containerWidth, TREE_LIMIT.min, TREE_LIMIT.max);
  const summaryDrag = dragLimit(shown.tree, containerWidth, SUMMARY_LIMIT.min, SUMMARY_LIMIT.max);
  const files = useMemo(() => orderCommentedFirst(model.files, reviewFindingCount), [model.files]);
  return (
    <AppShell
      current="reviews"
      title={model.heading}
      status={status}
      fill
      crumbs={
        <a className="shrink-0 text-sm text-muted-foreground hover:text-foreground" href={model.backHref}>
          Reviews
        </a>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <ReviewMeta model={model} />
        <div
          ref={columnsRef}
          className="review-columns min-h-0 flex-1"
          style={{ ["--tree-width" as string]: `${shown.tree}px`, ["--summary-width" as string]: `${shown.summary}px` }}
        >
          <aside className="flex max-h-72 min-h-0 flex-col overflow-hidden border-b min-[960px]:max-h-none min-[960px]:border-r min-[960px]:border-b-0">
            {files.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">No changed files.</p>
            ) : (
              <ReviewTree files={files} preloaded={presentation?.tree ?? null} />
            )}
            {model.hiddenFiles > 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">{model.hiddenFiles} more files are not shown.</p>
            ) : null}
          </aside>
          <PanelHandle
            label="Resize file tree"
            width={shown.tree}
            min={treeDrag.min}
            max={treeDrag.max}
            onWidth={(requested) => setTreePref(clamp(requested, treeDrag.min, treeDrag.max))}
          />
          <div className="min-h-0 min-w-0 overflow-auto border-b min-[960px]:border-r min-[960px]:border-b-0">
            <DiffColumn files={files} model={model} presentation={presentation} diffStyle={diffStyle} />
          </div>
          <PanelHandle
            label="Resize summary"
            width={shown.summary}
            min={summaryDrag.min}
            max={summaryDrag.max}
            invert
            onWidth={(requested) => setSummaryPref(clamp(requested, summaryDrag.min, summaryDrag.max))}
          />
          <aside className="min-h-0 overflow-x-hidden overflow-y-auto">
            <SummaryRail summary={model.summary} />
            <ReviewConfig settings={model.settings} />
          </aside>
        </div>
      </div>
    </AppShell>
  );
}

function ReviewMeta({ model }: { model: ReviewDetailModel }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2">
      {model.pullHref ? (
        <a className="max-w-full truncate text-sm font-medium underline-offset-4 hover:underline" href={model.pullHref} rel="noreferrer">
          {model.pullLabel}
        </a>
      ) : (
        <span className="max-w-full truncate text-sm font-medium">{model.pullLabel}</span>
      )}
      <Badge variant={model.resultKind}>{model.resultText}</Badge>
      <span className="text-xs text-muted-foreground">{model.triggerLabel}</span>
      <span className="text-xs text-muted-foreground">{model.duration}</span>
      {model.whenLabel ? (
        <span className="text-xs text-muted-foreground">
          <LocalTime iso={model.whenIso} label={model.whenLabel} />
        </span>
      ) : null}
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
  useLayoutEffect(() => {
    model.openSearch("");
  }, [model]);
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
  files,
  model,
  presentation,
  diffStyle,
}: {
  files: DetailFileView[];
  model: ReviewDetailModel;
  presentation?: ReviewPresentation;
  diffStyle: "unified" | "split";
}) {
  const diffTheme = useDiffTheme();
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const [expandedGaps, setExpandedGaps] = useState<Record<string, true>>({});
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const isOpen = (file: DetailFileView) => {
    const stored = openFiles[file.anchor];
    if (stored !== undefined) return stored;
    return reviewFindingCount(file) > 0;
  };
  useEffect(() => {
    const reveal = (raw: string) => {
      const id = decodeHash(raw);
      if (!id) return;
      const file = fileForHash(files, id);
      if (!file) return;
      setOpenFiles((current) => (current[file.anchor] === true ? current : { ...current, [file.anchor]: true }));
      setPendingScroll(id);
    };
    const fromLocation = () => reveal(window.location.hash.slice(1));
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest("a[href^='#']");
      if (!(link instanceof HTMLAnchorElement)) return;
      const href = link.getAttribute("href");
      if (!href || href.length < 2) return;
      reveal(href.slice(1));
    };
    fromLocation();
    window.addEventListener("hashchange", fromLocation);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", fromLocation);
      document.removeEventListener("click", onClick);
    };
  }, [files]);
  useLayoutEffect(() => {
    if (!pendingScroll) return;
    let attempts = 0;
    let frame = 0;
    let cancelled = false;
    const tryScroll = () => {
      if (cancelled) return;
      const target = document.getElementById(pendingScroll);
      if (target) {
        target.scrollIntoView({ block: "center" });
        setPendingScroll(null);
        return;
      }
      attempts += 1;
      if (attempts < 12) frame = requestAnimationFrame(tryScroll);
    };
    tryScroll();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [pendingScroll, openFiles]);
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
      {model.noChangedFiles ? <p className="px-3 py-4 text-sm text-muted-foreground">GitHub returned no changed files.</p> : null}
      {files.map((file) => (
        <FileBlock
          key={file.anchor}
          file={file}
          open={isOpen(file)}
          onToggle={() => setOpenFiles((current) => ({ ...current, [file.anchor]: !isOpen(file) }))}
          expandedGaps={expandedGaps}
          onExpand={(key) => setExpandedGaps((current) => ({ ...current, [key]: true }))}
          onCollapse={(key) =>
            setExpandedGaps((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            })
          }
          diffStyle={diffStyle}
          diffTheme={diffTheme}
          presentation={presentation}
        />
      ))}
      <CommentGroup title={model.outsideTitle} comments={model.outside} />
    </div>
  );
}

function FileBlock({
  file,
  open,
  onToggle,
  expandedGaps,
  onExpand,
  onCollapse,
  diffStyle,
  diffTheme,
  presentation,
}: {
  file: DetailFileView;
  open: boolean;
  onToggle: () => void;
  expandedGaps: Record<string, true>;
  onExpand: (key: string) => void;
  onCollapse: (key: string) => void;
  diffStyle: "unified" | "split";
  diffTheme: "light" | "dark";
  presentation?: ReviewPresentation;
}) {
  const findings = reviewFindingCount(file);
  const anchors = commentAnchorIndexes(file.lines);
  const prefix = `${file.anchor}:`;
  const expanded = new Set(
    Object.keys(expandedGaps)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)),
  );
  const segments = open ? focusSegments(file.lines, anchors, expanded) : [];
  return (
    <section id={file.anchor} className="scroll-mt-12 border-b target:bg-muted/40">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-3 py-2">
        <button
          type="button"
          className="shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${file.filename}`}
          onClick={onToggle}
        >
          {open ? "Collapse" : "Expand"}
        </button>
        <span className="min-w-0 truncate font-mono text-xs">{file.filename}</span>
        <Badge variant="outline">{file.status}</Badge>
        {file.stats ? <span className="text-xs text-muted-foreground">{file.stats}</span> : null}
        {findings === 0 ? <span className="text-xs text-muted-foreground">No comments</span> : null}
      </header>
      {open ? (
        file.patchMissing || !file.diffText ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">GitHub did not include a patch for this file.</p>
        ) : (
          segments.map((segment) => (
            <FocusSegmentView
              key={`${segment.kind}:${segment.start}:${segment.end}`}
              file={file}
              segment={segment}
              diffStyle={diffStyle}
              diffTheme={diffTheme}
              presentation={presentation}
              wholeFile={anchors.length === 0}
              onExpand={() => onExpand(`${file.anchor}:${gapKey(segment.start, segment.end)}`)}
              onCollapse={() => onCollapse(`${file.anchor}:${gapKey(segment.start, segment.end)}`)}
            />
          ))
        )
      ) : null}
      {open && file.patchTruncated ? <p className="px-3 py-2 text-sm text-muted-foreground">Patch truncated.</p> : null}
      {open ? <CommentGroup title="Not on a line in this diff" comments={file.unanchored} /> : null}
    </section>
  );
}

function FocusSegmentView({
  file,
  segment,
  diffStyle,
  diffTheme,
  presentation,
  wholeFile,
  onExpand,
  onCollapse,
}: {
  file: DetailFileView;
  segment: FocusSegment;
  diffStyle: "unified" | "split";
  diffTheme: "light" | "dark";
  presentation?: ReviewPresentation;
  wholeFile: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  if (segment.kind === "hidden") {
    const label = segment.lines === 1 ? "1 hidden line" : `${segment.lines} hidden lines`;
    return (
      <button
        type="button"
        className="flex w-full items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onExpand}
      >
        {label}
      </button>
    );
  }
  const lines = sliceLines(file.lines, segment.start, segment.end);
  const patch = wholeFile ? file.diffText : windowDiffText(file, lines);
  const parsed = patch ? parseReviewPatch(patch) : null;
  const preloadKey = wholeFile ? `${file.anchor}:full` : `${file.anchor}:${segment.start}-${segment.end}`;
  return (
    <div>
      {segment.collapsible ? (
        <button
          type="button"
          className="flex w-full items-center border-b px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onCollapse}
        >
          Collapse
        </button>
      ) : null}
      {parsed ? (
        <FileDiff
          fileDiff={parsed}
          options={reviewDiffOptions({ diffStyle, themeType: diffTheme, lines })}
          lineAnnotations={reviewAnnotations({ ...file, lines })}
          prerenderedHTML={
            diffStyle === "unified" && diffTheme === "light" ? presentation?.diffs[preloadKey] : undefined
          }
          disableWorkerPool
          renderAnnotation={renderFinding}
        />
      ) : (
        <PlainLines lines={lines} />
      )}
    </div>
  );
}

function useDiffTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const sync = () => setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function useStoredWidth(key: string, fallback: number, max: number): [number, (value: number) => void] {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === null) return;
      const parsed = Number(stored);
      if (Number.isFinite(parsed)) setWidth(clamp(parsed, 0, max));
    } catch {
      // Keep the default width.
    }
  }, [key, max]);
  return [
    width,
    (value) => {
      const next = clamp(value, 0, max);
      setWidth(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // The width still applies until reload.
      }
    },
  ];
}

function PanelHandle({
  label,
  width,
  min,
  max,
  invert = false,
  onWidth,
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  invert?: boolean;
  onWidth: (value: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      className="panel-handle cursor-col-resize bg-transparent hover:bg-foreground/15 focus-visible:bg-foreground/20 focus-visible:outline-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const start = width;
        const move = (pointer: PointerEvent) => {
          const delta = pointer.clientX - startX;
          onWidth(start + (invert ? -delta : delta));
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onKeyDown={(event) => {
        const step = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
        if (step === 0) return;
        event.preventDefault();
        onWidth(width + (invert ? -step : step));
      }}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function renderFinding(annotation: DiffLineAnnotation<DetailCommentView>): ReactNode {
  return <CommentCard comment={annotation.metadata} inset />;
}

function PlainLines({ lines }: { lines: DetailLineView[] }) {
  return (
    <div className="font-mono text-xs leading-5">
      {lines.map((line, index) => (
        <DiffLine key={`${line.kind}-${line.newLabel}-${line.oldLabel}-${index}`} line={line} />
      ))}
    </div>
  );
}

function DiffLine({ line }: { line: DetailLineView }) {
  if (line.kind === "hunk") {
    return <div className="bg-muted px-3 py-0.5 text-muted-foreground">{line.text}</div>;
  }
  const tone = line.severity === null ? "" : (LINE_BOX[line.severity] ?? "");
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
      <p className="px-3 pt-2 pb-1 text-sm font-medium">{title}</p>
      {comments.map((comment) => (
        <CommentCard key={comment.ordinal} comment={comment} />
      ))}
    </div>
  );
}

function CommentCard({ comment, inset }: { comment: DetailCommentView; inset?: boolean }) {
  const accent = COMMENT_ACCENT[comment.priority] ?? COMMENT_ACCENT[3];
  return (
    <article
      id={comment.anchor}
      className={`my-2 rounded-md border border-border border-l-[3px] px-3 py-2.5 ${accent} ${inset ? "mr-3 ml-10" : "mx-3"}`}
    >
      <header className="mb-1 flex flex-wrap items-baseline gap-2">
        <Badge className={PRIORITY_BADGE[comment.priority] ?? PRIORITY_BADGE[3]}>P{comment.priority}</Badge>
        {comment.tags.map((tag) => (
          <span key={tag} className="text-xs text-muted-foreground">
            {tag}
          </span>
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
            <span key={item} className="block font-mono text-xs">
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
      <h2 className="mb-2 text-sm font-medium">Summary</h2>
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
                <span className="font-mono text-xs text-muted-foreground">{finding.where}</span>
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

function ReviewConfig({ settings }: { settings: DetailSettings }) {
  return (
    <details className="border-t px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">Review configuration</summary>
      {settings.recorded ? (
        <dl className="mt-2 grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-sm">
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
        <p className="mt-2 text-sm text-muted-foreground">Settings were not recorded for this review.</p>
      )}
    </details>
  );
}

function fileForHash(files: DetailFileView[], id: string): DetailFileView | undefined {
  return files.find(
    (item) =>
      item.anchor === id ||
      item.lines.some((line) => line.comments.some((comment) => comment.anchor === id)) ||
      item.unanchored.some((comment) => comment.anchor === id),
  );
}

function decodeHash(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function verdictTone(kind: "pass" | "suggest" | "blocker" | null): string {
  if (kind === "blocker") return "text-red-700 dark:text-red-300";
  if (kind === "suggest") return "text-amber-800 dark:text-amber-300";
  if (kind === "pass") return "text-emerald-800 dark:text-emerald-300";
  return "";
}
