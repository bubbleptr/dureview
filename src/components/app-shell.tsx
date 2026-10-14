import { useEffect, useState, type ReactNode } from "react";
import { ChartColumn, GitPullRequest, LayoutDashboard, PanelLeft, Settings } from "lucide-react";
import type { CodexView } from "../ui/list-model.js";
import { LocalTime } from "./local-time.js";
import { ThemeToggle } from "./theme.js";

export type ShellSection = "overview" | "reviews" | "stats" | "settings";

export type ShellStatus = {
  version: string;
  uptime: string;
  provider: string;
  model: string;
  thinking: string;
  codex: CodexView;
  githubApp: boolean;
  githubToken: boolean;
};

const NAV = [
  ["overview", "/ui", "Overview", LayoutDashboard],
  ["reviews", "/ui#reviews", "Reviews", GitPullRequest],
  ["stats", "/ui/stats", "Stats", ChartColumn],
  ["settings", "/ui/settings", "Settings", Settings],
] as const;

export function AppShell({
  current,
  title,
  crumbs,
  status,
  filters,
  form,
  fill,
  children,
}: {
  current: ShellSection;
  title: string;
  crumbs?: ReactNode;
  status?: ShellStatus | null;
  filters?: ReactNode;
  form?: { method: "get" | "post"; action: string };
  fill?: boolean;
  children: ReactNode;
}) {
  const hash = useHash();
  const active = current === "overview" && hash === "#reviews" ? "reviews" : current;
  const column = (
    <>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b bg-background px-3 py-2">
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Toggle sidebar"
          onClick={toggleNav}
        >
          <PanelLeft className="size-4" />
        </button>
        <div className="flex min-w-0 items-center gap-2">
          {crumbs ? (
            <>
              <div className="shrink-0 text-sm text-muted-foreground">{crumbs}</div>
              <span className="text-muted-foreground/50" aria-hidden="true">
                /
              </span>
            </>
          ) : null}
          <h1 className="truncate text-base font-medium">{title}</h1>
        </div>
        <div className="ml-auto flex w-full flex-wrap items-end justify-end gap-2 sm:w-auto">
          {filters}
          <ThemeToggle />
        </div>
      </header>
        <main id="main" className={fill ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "min-h-0 min-w-0 flex-1 overflow-auto"}>
        {fill ? children : <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-10 p-4 md:p-6">{children}</div>}
      </main>
    </>
  );
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <button type="button" className="mobile-backdrop fixed inset-0 z-30 bg-black/40" aria-label="Close menu" onClick={closeMobile} />
      <aside className="app-sidebar flex h-full shrink-0 flex-col border-r bg-background" aria-label="Sidebar">
        <div className="flex h-12 items-center px-3">
          <a href="/ui" className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={closeMobile}>
            <span className="brand-mark size-6 place-items-center text-sm font-medium">d</span>
            <span className="brand-name truncate text-sm font-medium">dureview</span>
          </a>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2" aria-label="Dashboard">
          {NAV.map(([id, href, label, Icon]) => {
            const on = active === id;
            return (
              <a
                key={id}
                href={href}
                title={label}
                aria-current={on ? "page" : undefined}
                onClick={closeMobile}
                className={
                  on
                    ? "nav-link flex h-8 items-center gap-2 rounded-md bg-accent px-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    : "nav-link flex h-8 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                }
              >
                <Icon className="size-4 shrink-0" />
                <span className="nav-label truncate">{label}</span>
              </a>
            );
          })}
        </nav>
        <div className="sidebar-footer-detail border-t px-3 py-3">{status ? <StatusLine status={status} /> : <p className="text-[11px] text-muted-foreground">dureview</p>}</div>
      </aside>
      {form ? (
        <form className="flex min-w-0 flex-1 flex-col" method={form.method} action={form.action}>
          {column}
        </form>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">{column}</div>
      )}
    </div>
  );
}

function StatusLine({ status }: { status: ShellStatus }) {
  return (
    <div className="flex flex-col gap-1 text-xs leading-5 break-words text-muted-foreground">
      <p className="font-medium text-foreground">ChatGPT</p>
      <p>
        {status.version}
        {" · "}
        up {status.uptime}
      </p>
      <p>
        {status.provider}/{status.model}
        {" · "}
        {status.thinking}
      </p>
      <p>
        {status.codex.kind === "plain" ? (
          status.codex.text
        ) : (
          <>
            {status.codex.lead}
            <LocalTime iso={status.codex.iso} label={status.codex.label} />
          </>
        )}
      </p>
      <p>
        GitHub App <b>{status.githubApp ? "yes" : "no"}</b>
      </p>
      <p>
        GitHub token <b>{status.githubToken ? "yes" : "no"}</b>
      </p>
    </div>
  );
}

function useHash(): string {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  return hash;
}

function toggleNav(): void {
  const root = document.documentElement;
  if (!window.matchMedia("(min-width: 768px)").matches) {
    if (root.dataset.mobileNav === "open") delete root.dataset.mobileNav;
    else root.dataset.mobileNav = "open";
    return;
  }
  if (root.dataset.sidebar === "collapsed") {
    delete root.dataset.sidebar;
    localStorage.setItem("dureview-sidebar", "expanded");
  } else {
    root.dataset.sidebar = "collapsed";
    localStorage.setItem("dureview-sidebar", "collapsed");
  }
}

function closeMobile(): void {
  delete document.documentElement.dataset.mobileNav;
}
