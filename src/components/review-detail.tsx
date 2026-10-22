import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type {
  DetailCommentView,
  DetailFileView,
  DetailLineView,
  DetailSettings,
  DetailSummary,
  ReviewDetailHeader,
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
import { fill } from "../ui/format.js";
import { useI18n } from "../ui/i18n.js";
import type { Messages } from "../ui/messages.js";
import { reviewFindingCount, reviewHighlighterPreload, reviewTreeOptions, type ReviewTreePreload } from "../ui/review-presentation.js";
import { dragLimit, fitPanelWidths, SUMMARY_LIMIT, TREE_LIMIT } from "../ui/panel-widths.js";
import { splitCodeRows } from "../ui/split-rows.js";
import { providerAtStart } from "../auth/providers.js";
import { preloadHighlighter } from "@pierre/diffs";
import { AppShell } from "./app-shell.js";
import { useDiffStyle, type DiffStyle } from "./diff-style.js";
import { ConfidenceSignal, FindingTypeIcon, PriorityBadge } from "./finding-marks.js";
import { LocalTime } from "./local-time.js";
import { ProviderMark } from "./provider-mark.js";
import { Badge } from "./ui/badge.js";

const COMMENT_ACCENT = [
  "border-l-chart-1 bg-[color-mix(in_oklch,var(--chart-1)_12%,transparent)]",
  "border-l-chart-2 bg-[color-mix(in_oklch,var(--chart-2)_12%,transparent)]",
  "border-l-chart-3 bg-[color-mix(in_oklch,var(--chart-3)_12%,transparent)]",
  "border-l-chart-4 bg-[color-mix(in_oklch,var(--chart-4)_12%,transparent)]",
] as const;

const LINE_BOX = [
  "bg-[color-mix(in_oklch,var(--chart-1)_12%,transparent)] shadow-[inset_3px_0_0_var(--chart-1),inset_0_1px_0_var(--chart-1),inset_0_-1px_0_var(--chart-1)]",
  "bg-[color-mix(in_oklch,var(--chart-2)_12%,transparent)] shadow-[inset_3px_0_0_var(--chart-2),inset_0_1px_0_var(--chart-2),inset_0_-1px_0_var(--chart-2)]",
  "bg-[color-mix(in_oklch,var(--chart-3)_12%,transparent)] shadow-[inset_3px_0_0_var(--chart-3),inset_0_1px_0_var(--chart-3),inset_0_-1px_0_var(--chart-3)]",
  "bg-[color-mix(in_oklch,var(--chart-4)_12%,transparent)] shadow-[inset_3px_0_0_var(--chart-4),inset_0_1px_0_var(--chart-4),inset_0_-1px_0_var(--chart-4)]",
] as const;

const COUNT_TONE: Record<string, string> = {
  P0: "text-chart-1",
  P1: "text-chart-2",
  P2: "text-chart-3",
  P3: "text-chart-4",
};

const TREE_WIDTH_KEY = "dureview-tree-width";
const SUMMARY_WIDTH_KEY = "dureview-summary-width";

export function ReviewDetailView({
  model,
  tree = null,
  diffStyle: diffStyleProp,
}: {
  model: ReviewDetailModel;
  tree?: ReviewTreePreload | null;
  diffStyle?: DiffStyle;
}) {
  const { m } = useI18n();
  const [storedStyle] = useDiffStyle();
  const diffStyle = diffStyleProp ?? storedStyle;
  const columns = useReviewColumns();
  const { shown, containerWidth, setTreePref, setSummaryPref } = columns;
  const treeDrag = dragLimit(shown.summary, containerWidth, TREE_LIMIT.min, TREE_LIMIT.max);
  const summaryDrag = dragLimit(shown.tree, containerWidth, SUMMARY_LIMIT.min, SUMMARY_LIMIT.max);
  const files = useMemo(() => orderCommentedFirst(model.files, reviewFindingCount), [model.files]);
  const theme = useDiffTheme();
  return (
    <AppShell
      current="reviews"
      title={model.heading}
      fill
      crumbs={
        <a className="shrink-0 text-sm text-muted-foreground hover:text-foreground" href={model.backHref}>
          {m.shell.reviews}
        </a>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <ReviewMeta model={model} />
        <div
          ref={columns.columnsRef}
          className="review-columns min-h-0 flex-1"
          style={{ ["--tree-width" as string]: `${shown.tree}px`, ["--summary-width" as string]: `${shown.summary}px` }}
        >
          <aside className="review-panel flex flex-col border-b min-[960px]:border-r min-[960px]:border-b-0">
            {files.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">{m.detail.noFiles}</p>
            ) : (
              <ReviewTree files={files} preloaded={tree} theme={theme} />
            )}
            {model.hiddenFiles > 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">{fill(m.detail.moreFiles, { count: model.hiddenFiles })}</p>
            ) : null}
          </aside>
          <PanelHandle
            label={m.detail.resizeTree}
            width={shown.tree}
            min={treeDrag.min}
            max={treeDrag.max}
            onWidth={(requested) => setTreePref(clamp(requested, treeDrag.min, treeDrag.max))}
          />
          <div className="review-panel border-b min-[960px]:border-r min-[960px]:border-b-0">
            <DiffColumn files={files} model={model} diffStyle={diffStyle} theme={theme} />
          </div>
          <PanelHandle
            label={m.detail.resizeSummary}
            width={shown.summary}
            min={summaryDrag.min}
            max={summaryDrag.max}
            invert
            onWidth={(requested) => setSummaryPref(clamp(requested, summaryDrag.min, summaryDrag.max))}
          />
          <aside className="review-panel">
            <SummaryRail summary={model.summary} />
            <ReviewConfig settings={model.settings} />
          </aside>
        </div>
      </div>
    </AppShell>
  );
}

export function ReviewDetailPending({ header }: { header: ReviewDetailHeader }) {
  const { m } = useI18n();
  const [diffStyle] = useDiffStyle();
  return (
    <ReviewFrame header={header}>
      <FileTreeSkeleton label={m.detail.loadingFiles} />
      <div className="panel-handle" aria-hidden="true" />
      <DiffSkeleton label={m.detail.loadingDiff} diffStyle={diffStyle} />
      <div className="panel-handle" aria-hidden="true" />
      <SummarySkeleton label={m.detail.loadingSummary} />
    </ReviewFrame>
  );
}

export function ReviewDetailUnavailable({
  header,
  message,
}: {
  header: ReviewDetailHeader;
  message: string;
}) {
  return (
    <ReviewFrame header={header}>
      <p role="alert" className="review-panel px-3 py-4 text-sm" style={{ gridColumn: "1 / -1" }}>
        {message}
      </p>
    </ReviewFrame>
  );
}

function ReviewFrame({
  header,
  children,
}: {
  header: ReviewDetailHeader;
  children: ReactNode;
}) {
  const { m } = useI18n();
  const { columnsRef, shown } = useReviewColumns();
  return (
    <AppShell
      current="reviews"
      title={header.heading}
      fill
      crumbs={
        <a className="shrink-0 text-sm text-muted-foreground hover:text-foreground" href={header.backHref}>
          {m.shell.reviews}
        </a>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <ReviewMeta model={header} />
        <div
          ref={columnsRef}
          className="review-columns min-h-0 flex-1"
          style={{ ["--tree-width" as string]: `${shown.tree}px`, ["--summary-width" as string]: `${shown.summary}px` }}
        >
          {children}
        </div>
      </div>
    </AppShell>
  );
}

const SKELETON_FILE_ROWS = 8;
const SKELETON_CODE_ROWS = 48;

function FileTreeSkeleton({ label }: { label: string }) {
  return (
    <div className="review-panel flex min-h-0 flex-col border-b min-[960px]:border-r min-[960px]:border-b-0" role="status" aria-busy="true">
      <p className="sr-only">{label}</p>
      <div className="shrink-0 border-b px-2 py-2" aria-hidden="true">
        <div className="h-8 rounded-md border bg-background" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-2 py-1" aria-hidden="true">
        {Array.from({ length: SKELETON_FILE_ROWS }, (_, index) => (
          <div key={index} className="flex h-8 items-center gap-2">
            <div className="size-3.5 shrink-0 rounded-sm bg-muted" />
            <div
              className="h-3 animate-pulse rounded-sm bg-muted motion-reduce:animate-none"
              style={{ width: `${42 + ((index * 17) % 38)}%` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffSkeleton({ label, diffStyle }: { label: string; diffStyle: DiffStyle }) {
  return (
    <div className="review-panel flex min-h-0 flex-col border-b min-[960px]:border-r min-[960px]:border-b-0" role="status" aria-busy="true">
      <p className="sr-only">{label}</p>
      <div className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2" aria-hidden="true">
        <div className="h-5 w-16 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-3 w-40 max-w-[45%] animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        <div className="h-5 w-14 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden" aria-hidden="true">
        {diffStyle === "split" ? <SplitSkeletonRows /> : <UnifiedSkeletonRows />}
      </div>
    </div>
  );
}

function UnifiedSkeletonRows() {
  return (
    <div className="py-2">
      {Array.from({ length: SKELETON_CODE_ROWS }, (_, index) => (
        <div key={index} className="grid h-5 grid-cols-[3rem_3rem_minmax(0,1fr)] items-center gap-2 px-3">
          <div className="ml-auto h-2.5 w-5 rounded-sm bg-muted/70" />
          <div className="ml-auto h-2.5 w-5 rounded-sm bg-muted/70" />
          <div className="h-2.5 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" style={{ width: `${28 + ((index * 13) % 58)}%` }} />
        </div>
      ))}
    </div>
  );
}

function SplitSkeletonRows() {
  return (
    <div className="grid grid-cols-2 py-2">
      {Array.from({ length: SKELETON_CODE_ROWS }, (_, index) => (
        <Fragment key={index}>
          <div className="grid h-5 grid-cols-[3rem_minmax(0,1fr)] items-center gap-2 border-r px-3">
            <div className="ml-auto h-2.5 w-5 rounded-sm bg-muted/70" />
            <div className="h-2.5 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" style={{ width: `${24 + ((index * 11) % 52)}%` }} />
          </div>
          <div className="grid h-5 grid-cols-[3rem_minmax(0,1fr)] items-center gap-2 px-3">
            <div className="ml-auto h-2.5 w-5 rounded-sm bg-muted/70" />
            <div className="h-2.5 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" style={{ width: `${32 + ((index * 19) % 48)}%` }} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function SummarySkeleton({ label }: { label: string }) {
  return (
    <div className="review-panel" role="status" aria-busy="true">
      <p className="sr-only">{label}</p>
      <div className="border-b px-3 py-3" aria-hidden="true">
        <div className="mb-2 h-4 w-24 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        <div className="flex gap-2">
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="h-5 w-14 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-3 w-full animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
          <div className="h-3 w-5/6 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
          <div className="h-3 w-2/3 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
          <div className="h-3 w-3/4 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}

function ReviewMeta({ model }: { model: ReviewDetailHeader }) {
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
  theme,
}: {
  files: DetailFileView[];
  preloaded: ReviewTreePreload | null;
  theme: "light" | "dark";
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
      className="min-h-0"
      data-theme={theme}
    />
  );
}

function DiffColumn({
  files,
  model,
  diffStyle,
  theme,
}: {
  files: DetailFileView[];
  model: ReviewDetailModel;
  diffStyle: "unified" | "split";
  theme: "light" | "dark";
}) {
  const { m } = useI18n();
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
        <p className="border-b px-3 py-2 text-sm text-muted-foreground">{m.detail.diffUnavailable}</p>
      ) : null}
      {model.hiddenFiles > 0 ? (
        <p className="border-b px-3 py-2 text-sm text-muted-foreground">{fill(m.detail.hiddenOnPage, { count: model.hiddenFiles })}</p>
      ) : null}
      {model.noChangedFiles ? <p className="px-3 py-4 text-sm text-muted-foreground">{m.detail.githubNoFiles}</p> : null}
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
          diffTheme={theme}
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
}: {
  file: DetailFileView;
  open: boolean;
  onToggle: () => void;
  expandedGaps: Record<string, true>;
  onExpand: (key: string) => void;
  onCollapse: (key: string) => void;
  diffStyle: "unified" | "split";
  diffTheme: "light" | "dark";
}) {
  const { m } = useI18n();
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
          aria-label={fill(open ? m.detail.collapseNamed : m.detail.expandNamed, { name: file.filename })}
          onClick={onToggle}
        >
          {open ? m.detail.collapse : m.detail.expand}
        </button>
        <span className="min-w-0 truncate font-mono text-xs">{file.filename}</span>
        <Badge variant="outline">{file.status}</Badge>
        {file.stats ? <span className="text-xs text-muted-foreground">{file.stats}</span> : null}
        {findings === 0 ? <span className="text-xs text-muted-foreground">{m.detail.noComments}</span> : null}
      </header>
      {open ? (
        file.patchMissing || !file.diffText ? (
          <p className="px-3 py-2 text-sm text-muted-foreground">{m.detail.noPatch}</p>
        ) : (
          segments.map((segment) => (
            <FocusSegmentView
              key={`${segment.kind}:${segment.start}:${segment.end}`}
              file={file}
              segment={segment}
              diffStyle={diffStyle}
              diffTheme={diffTheme}
              wholeFile={anchors.length === 0}
              onExpand={() => onExpand(`${file.anchor}:${gapKey(segment.start, segment.end)}`)}
              onCollapse={() => onCollapse(`${file.anchor}:${gapKey(segment.start, segment.end)}`)}
            />
          ))
        )
      ) : null}
      {open && file.patchTruncated ? <p className="px-3 py-2 text-sm text-muted-foreground">{m.detail.patchTruncated}</p> : null}
      {open ? <CommentGroup title={m.detail.unanchored} comments={file.unanchored} /> : null}
    </section>
  );
}

function FocusSegmentView({
  file,
  segment,
  diffStyle,
  diffTheme,
  wholeFile,
  onExpand,
  onCollapse,
}: {
  file: DetailFileView;
  segment: FocusSegment;
  diffStyle: "unified" | "split";
  diffTheme: "light" | "dark";
  wholeFile: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const { m } = useI18n();
  if (segment.kind === "hidden") {
    const label = fill(segment.lines === 1 ? m.detail.hiddenLine : m.detail.hiddenLines, { count: segment.lines });
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
  return (
    <div>
      {segment.collapsible ? (
        <button
          type="button"
          className="flex w-full items-center border-b px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onCollapse}
        >
          {m.detail.collapse}
        </button>
      ) : null}
      {patch ? (
        <LazyPatch file={file} lines={lines} patch={patch} diffStyle={diffStyle} diffTheme={diffTheme} />
      ) : (
        <PlainLines lines={lines} diffStyle={diffStyle} />
      )}
    </div>
  );
}

type HighlightedPatch = typeof import("./review-diff.js").HighlightedPatch;

function LazyPatch({
  file,
  lines,
  patch,
  diffStyle,
  diffTheme,
}: {
  file: DetailFileView;
  lines: DetailLineView[];
  patch: string;
  diffStyle: "unified" | "split";
  diffTheme: "light" | "dark";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [Highlight, setHighlight] = useState<HighlightedPatch | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current?.querySelector("diffs-container");
    if (!(host instanceof HTMLElement)) return;
    host.setAttribute("data-theme", diffTheme);
    pinAnnotationColumn(host);
  }, [diffTheme, Highlight]);
  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    let cancelled = false;
    const load = () => {
      void Promise.all([import("./review-diff.js"), preloadHighlighter(reviewHighlighterPreload(file.filename))])
        .then(([mod]) => {
          if (!cancelled) setHighlight(() => mod.HighlightedPatch);
        })
        .catch(() => {
          // Keep the plain lines when the highlighter cannot start.
        });
    };
    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      },
      { rootMargin: "480px 0px" },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [file.filename]);
  const highlighted = Highlight ? (
    <Highlight
      file={file}
      lines={lines}
      patch={patch}
      diffStyle={diffStyle}
      diffTheme={diffTheme}
      renderComment={(comment) => <CommentCard comment={comment} inset />}
      fallback={<PlainLines lines={lines} diffStyle={diffStyle} />}
    />
  ) : null;
  return <div ref={hostRef}>{highlighted ?? <PlainLines lines={lines} diffStyle={diffStyle} />}</div>;
}

// Pierre assigns the annotation column width from a resize pass after the first layout.
// Until that variable exists the card is as wide as the unwrapped line and shorter than the settled card.
function pinAnnotationColumn(host: HTMLElement): void {
  const root = host.shadowRoot;
  if (!root) return;
  for (const code of root.querySelectorAll("[data-code]")) {
    if (!(code instanceof HTMLElement)) continue;
    const gutter = code.querySelector("[data-gutter]");
    const codeWidth = Math.floor(code.getBoundingClientRect().width);
    const numberWidth = gutter instanceof HTMLElement ? Math.ceil(gutter.getBoundingClientRect().width) : 0;
    const contentWidth = codeWidth - numberWidth;
    if (contentWidth <= 0) continue;
    code.style.setProperty("--diffs-column-content-width", `${contentWidth}px`);
    if (numberWidth > 0) code.style.setProperty("--diffs-column-number-width", `${numberWidth}px`);
  }
}

function useDiffTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useLayoutEffect(() => {
    const sync = () => setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// False during hydration so the first paint matches the server. Later mounts read storage immediately.
let widthsReady = false;

function useReviewColumns() {
  const [treePref, setTreePref] = useStoredWidth(TREE_WIDTH_KEY, TREE_LIMIT.fallback, TREE_LIMIT.max);
  const [summaryPref, setSummaryPref] = useStoredWidth(SUMMARY_WIDTH_KEY, SUMMARY_LIMIT.fallback, SUMMARY_LIMIT.max);
  const columnsRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = columnsRef.current;
    if (!node) return;
    const measure = () => setContainerWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return {
    columnsRef,
    containerWidth,
    shown: fitPanelWidths(treePref, summaryPref, containerWidth),
    setTreePref,
    setSummaryPref,
  };
}

function useStoredWidth(key: string, fallback: number, max: number): [number, (value: number) => void] {
  const [width, setWidth] = useState(() => (widthsReady ? readStoredWidth(key, fallback, max) : fallback));
  useLayoutEffect(() => {
    widthsReady = true;
    const next = readStoredWidth(key, fallback, max);
    if (next !== width) setWidth(next);
  }, [key, fallback, max, width]);
  return [
    width,
    (value) => {
      const next = clamp(value, 0, max);
      widthsReady = true;
      setWidth(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // The width still applies until reload.
      }
    },
  ];
}

function readStoredWidth(key: string, fallback: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    const parsed = Number(stored);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, 0, max);
  } catch {
    return fallback;
  }
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

function PlainLines({ lines, diffStyle }: { lines: DetailLineView[]; diffStyle: DiffStyle }) {
  if (diffStyle === "split") return <SplitPlain lines={lines} />;
  return <UnifiedPlain lines={lines} />;
}

function UnifiedPlain({ lines }: { lines: DetailLineView[] }) {
  return (
    <div className="py-2 font-mono text-[13px] leading-5">
      {lines.map((line, index) =>
        line.kind === "hunk" ? null : (
          <Fragment key={`${line.kind}-${line.newLabel}-${line.oldLabel}-${index}`}>
            <PlainCodeRow line={line} label={line.oldLabel} secondLabel={line.newLabel} />
            {line.comments.map((comment) => (
              <div key={comment.ordinal} className="flow-root">
                <CommentCard comment={comment} inset />
              </div>
            ))}
          </Fragment>
        ),
      )}
    </div>
  );
}

function SplitPlain({ lines }: { lines: DetailLineView[] }) {
  const rows = splitCodeRows(lines);
  return (
    <div className="grid grid-cols-2 py-2 font-mono text-[13px] leading-5">
      {rows.map((row, index) => (
        <Fragment key={index}>
          <div className="border-r border-border">
            <SplitCodeRow line={row.left} label={row.left?.oldLabel ?? ""} />
          </div>
          <div>
            <SplitCodeRow line={row.right} label={row.right?.newLabel ?? ""} />
            {row.right?.comments.map((comment) => (
              <div key={comment.ordinal} className="flow-root">
                <CommentCard comment={comment} inset />
              </div>
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function PlainCodeRow({ line, label, secondLabel }: { line: DetailLineView; label: string; secondLabel: string }) {
  const tone = line.severity === null ? "" : (LINE_BOX[line.severity] ?? "");
  return (
    <div className={`grid h-5 grid-cols-[3rem_3rem_1rem_minmax(0,1fr)] items-center gap-1 pr-3 ${tone}`}>
      <span className="text-right text-muted-foreground tabular-nums">{label}</span>
      <span className="text-right text-muted-foreground tabular-nums">{secondLabel}</span>
      <span className="text-muted-foreground">{line.mark}</span>
      <code className="overflow-hidden whitespace-pre">{line.text}</code>
    </div>
  );
}

function SplitCodeRow({ line, label }: { line: DetailLineView | null; label: string }) {
  if (!line) return <div className="h-5" />;
  const tone = line.severity === null ? "" : (LINE_BOX[line.severity] ?? "");
  return (
    <div className={`grid h-5 grid-cols-[3rem_minmax(0,1fr)] items-center gap-2 pr-3 ${tone}`}>
      <span className="text-right text-muted-foreground tabular-nums">{label}</span>
      <code className="overflow-hidden whitespace-pre">{line.text}</code>
    </div>
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
  const { m } = useI18n();
  const accent = COMMENT_ACCENT[comment.priority] ?? COMMENT_ACCENT[3];
  return (
    <article
      id={comment.anchor}
      className={`my-2 rounded-md border border-border border-l-[3px] px-3 py-2.5 ${accent} ${inset ? "mr-3 ml-10" : "mx-3"}`}
    >
      <header className="mb-1 flex flex-wrap items-center gap-2">
        <PriorityBadge priority={comment.priority} />
        <FindingTypeIcon type={comment.findingType} subtype={comment.subtype} label={comment.typeLabel} />
        {comment.tags.map((tag) => (
          <span key={tag} className="text-xs text-muted-foreground">
            {tag}
          </span>
        ))}
        <ConfidenceSignal value={comment.confidence} />
      </header>
      <h3 className="text-sm font-semibold">{comment.title}</h3>
      <p className="mt-1 text-sm">{comment.body}</p>
      {comment.trigger ? (
        <p className="mt-1 text-sm">
          <span className="mr-1 text-muted-foreground">{m.detail.trigger}</span>
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
  const { m } = useI18n();
  return (
    <section className="border-b px-3 py-3">
      <h2 className="mb-2 text-sm font-medium">{m.detail.summary}</h2>
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
  const { m } = useI18n();
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
      {summary.noComments ? <p className="mt-3 text-sm text-muted-foreground">{m.detail.noSavedComments}</p> : null}
      {summary.findings.length > 0 ? (
        <ul className="-mx-3 mt-3">
          {summary.findings.map((finding) => (
            <li key={finding.anchor} className="border-t">
              <a className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-muted/50" href={`#${finding.anchor}`}>
                <PriorityBadge priority={finding.priority} />
                <FindingTypeIcon type={finding.findingType} subtype={finding.subtype} label={finding.typeLabel} />
                <ConfidenceSignal value={finding.confidence} />
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
  const { m } = useI18n();
  return (
    <details className="border-t px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{m.detail.configuration}</summary>
      {settings.recorded ? (
        <dl className="mt-2 grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-sm">
          {settings.rows.map((row) => (
            <Fragment key={row.key}>
              <dt className="text-muted-foreground">{configLabel(row.key, m.detail.configKeys)}</dt>
              <dd className="min-w-0 truncate" title={row.value}>
                <SettingValue row={row} />
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{m.detail.settingsMissing}</p>
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

function SettingValue({ row }: { row: { key: string; value: string } }) {
  const provider = row.key === "model" ? providerAtStart(row.value) : null;
  if (!provider) return row.value;
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <ProviderMark provider={provider} />
      <span className="min-w-0 truncate">{row.value}</span>
    </span>
  );
}

function configLabel(key: string, labels: Messages["detail"]["configKeys"]): string {
  for (const [name, label] of Object.entries(labels)) {
    if (name === key) return label;
  }
  return key;
}

function verdictTone(kind: "pass" | "suggest" | "blocker" | null): string {
  if (kind === "blocker") return "text-red-700 dark:text-red-300";
  if (kind === "suggest") return "text-amber-800 dark:text-amber-300";
  if (kind === "pass") return "text-emerald-800 dark:text-emerald-300";
  return "";
}
