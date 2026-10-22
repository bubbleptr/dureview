import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { HighlightedPatch } from "../../src/components/review-diff.js";
import type { DetailCommentView, DetailFileView, DetailLineView } from "../../src/ui/detail-model.js";
import "../../src/styles.css";
import { largeFixture, smallFixture, type BenchFixture } from "./fixtures.js";

type BenchTask = { start: number; duration: number };

type BenchController = {
  tasks: BenchTask[];
  wasmCompiles: number;
  highlightReady?: boolean;
  fixture?: {
    name: string;
    changedLines: number;
    totalPatchChars: number;
    largestPatchChars: number;
    largestGitPatchChars: number;
    files: number;
  };
  sample?: string;
  interact?: (kind: "theme" | "collapse" | "expand") => Promise<InteractionResult>;
  highlightResult?: () => HighlightResult;
};

type HighlightResult = {
  highlightMs: number;
  longTaskTotalMs: number;
  longestTaskMs: number;
  longTaskCount: number;
  wasmCompiles: number;
  hosts: number;
  tokenSpans: number;
};

type InteractionResult = {
  kind: string;
  busyMs: number;
  longTaskTotalMs: number;
  longestTaskMs: number;
  longTaskCount: number;
};

declare global {
  interface Window {
    __bench: BenchController;
  }
}

const params = new URLSearchParams(location.search);
const fixture: BenchFixture = params.get("fixture") === "large" ? largeFixture() : smallFixture();
window.__bench.fixture = {
  name: fixture.name,
  changedLines: fixture.changedLines,
  totalPatchChars: fixture.totalPatchChars,
  largestPatchChars: fixture.largestPatchChars,
  largestGitPatchChars: fixture.largestGitPatchChars,
  files: fixture.files.length,
};

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

function PatchHost({
  file,
  lines,
  patch,
  diffTheme,
}: {
  file: DetailFileView;
  lines: DetailLineView[];
  patch: string;
  diffTheme: "light" | "dark";
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current?.querySelector("diffs-container");
    if (host instanceof HTMLElement) host.setAttribute("data-theme", diffTheme);
  }, [diffTheme]);
  return (
    <div ref={hostRef}>
      <HighlightedPatch
        file={file}
        lines={lines}
        patch={patch}
        diffStyle="unified"
        diffTheme={diffTheme}
        renderComment={(comment) => <Annotation comment={comment} />}
        fallback={<p data-bench="fallback">plain</p>}
      />
    </div>
  );
}

function Annotation({ comment }: { comment: DetailCommentView }): ReactNode {
  return (
    <article id={comment.anchor} data-bench="annotation">
      <h3>{comment.title}</h3>
      <p>{comment.body}</p>
    </article>
  );
}

function OpenFile({ file, theme }: { file: DetailFileView; theme: "light" | "dark" }) {
  const lines = file.lines.slice();
  const patch = file.diffText ?? "";
  return <PatchHost file={file} lines={lines} patch={patch} diffTheme={theme} />;
}

function PerfApp() {
  const theme = useDiffTheme();
  const [closed, setClosed] = useState<string | null>(null);
  const toggleName = fixture.files[0]?.filename ?? "";
  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const hosts = [...document.querySelectorAll("diffs-container")];
      if (hosts.length >= fixture.files.length && hosts.every((host) => hostHighlighted(host))) {
        performance.mark("highlight-ready");
        window.__bench.highlightReady = true;
        return;
      }
      const sampleHost = hosts[0];
      if (sampleHost instanceof HTMLElement && sampleHost.shadowRoot) {
        window.__bench.sample = sampleHost.shadowRoot.innerHTML.slice(0, 500);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    window.__bench.highlightResult = () => highlightResult();
    window.__bench.interact = (kind) => interact(kind, toggleName);
  }, [toggleName]);
  return (
    <div>
      <button
        type="button"
        data-bench="toggle-theme"
        onClick={() => {
          const root = document.documentElement;
          const next = root.classList.contains("dark") ? "light" : "dark";
          root.classList.toggle("dark", next === "dark");
          root.style.colorScheme = next;
        }}
      >
        theme
      </button>
      <button
        type="button"
        data-bench="toggle-one"
        onClick={() => setClosed((current) => (current === toggleName ? null : toggleName))}
      >
        toggle
      </button>
      {fixture.files.map((file) => (
        <section key={file.anchor} id={file.anchor}>
          <header className="sticky top-0 z-10 border-b bg-background px-3 py-2 font-mono text-xs" data-bench="file-header">
            {file.filename}
          </header>
          {closed === file.filename ? null : <OpenFile file={file} theme={theme} />}
        </section>
      ))}
    </div>
  );
}

function hostHighlighted(host: Element): boolean {
  if (!(host instanceof HTMLElement) || host.shadowRoot === null) return false;
  const lines = host.shadowRoot.querySelectorAll("[data-line]");
  if (lines.length < 3) return false;
  return hasToken(lines[0]) && hasToken(lines[lines.length - 1]);
}

function hasToken(line: Element | undefined): boolean {
  if (!line) return false;
  const token = line.querySelector("span");
  if (!(token instanceof HTMLElement)) return false;
  const style = token.getAttribute("style") ?? "";
  return style.includes("--diffs-token") || style.includes("color:") || token.className.length > 0;
}

function highlightResult(): HighlightResult {
  const start = performance.getEntriesByName("render-start")[0]?.startTime ?? 0;
  const end = performance.getEntriesByName("highlight-ready")[0]?.startTime ?? performance.now();
  const tasks = overlapping(start, end);
  return {
    highlightMs: end - start,
    longTaskTotalMs: total(tasks),
    longestTaskMs: longest(tasks),
    longTaskCount: tasks.length,
    wasmCompiles: window.__bench.wasmCompiles,
    hosts: document.querySelectorAll("diffs-container").length,
    tokenSpans: document.querySelectorAll("diffs-container").length
      ? [...document.querySelectorAll("diffs-container")].reduce((sum, host) => {
          if (!(host instanceof HTMLElement) || host.shadowRoot === null) return sum;
          return sum + host.shadowRoot.querySelectorAll("[data-line] span").length;
        }, 0)
      : 0,
  };
}

async function interact(kind: "theme" | "collapse" | "expand", toggleName: string): Promise<InteractionResult> {
  const start = performance.now();
  if (kind === "theme") {
    document.querySelector<HTMLButtonElement>("[data-bench='toggle-theme']")?.click();
    await waitFor(() => [...document.querySelectorAll("diffs-container")].every((host) => host.getAttribute("data-theme") === "dark"));
  } else {
    document.querySelector<HTMLButtonElement>("[data-bench='toggle-one']")?.click();
    if (kind === "collapse") {
      await waitFor(() => document.getElementById(sectionId(toggleName))?.querySelector("diffs-container") == null);
    } else {
      await waitFor(() => {
        const host = document.getElementById(sectionId(toggleName))?.querySelector("diffs-container");
        return host instanceof Element && hostHighlighted(host);
      });
    }
  }
  const rafAt = await nextFrame();
  await quiet();
  const tasks = overlapping(start, performance.now());
  const lastTaskEnd = tasks.reduce((max, task) => Math.max(max, task.start + task.duration), start);
  return {
    kind,
    busyMs: Math.max(lastTaskEnd, rafAt) - start,
    longTaskTotalMs: total(tasks),
    longestTaskMs: longest(tasks),
    longTaskCount: tasks.length,
  };
}

function sectionId(filename: string): string {
  return fixture.files.find((file) => file.filename === filename)?.anchor ?? "";
}

function overlapping(start: number, end: number): BenchTask[] {
  return window.__bench.tasks.filter((task) => task.start < end && task.start + task.duration > start);
}

function total(tasks: BenchTask[]): number {
  return tasks.reduce((sum, task) => sum + task.duration, 0);
}

function longest(tasks: BenchTask[]): number {
  return tasks.reduce((max, task) => Math.max(max, task.duration), 0);
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
  });
}

async function quiet(): Promise<void> {
  let stableSince = performance.now();
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const newest = window.__bench.tasks.at(-1);
    const newestEnd = newest ? newest.start + newest.duration : 0;
    if (newestEnd > stableSince) stableSince = performance.now();
    if (performance.now() - stableSince >= 300) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function waitFor(ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + 60_000;
    const tick = () => {
      if (ready()) {
        resolve();
        return;
      }
      if (performance.now() > deadline) {
        reject(new Error("timed out waiting for the diff DOM"));
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

performance.mark("render-start");
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<PerfApp />);
