import { useEffect, useRef, type ReactNode } from "react";
import { GitPullRequest, LayoutDashboard, PanelLeft, Settings } from "lucide-react";
import { useI18n } from "../ui/i18n.js";
import { mobileSidebarConcealed } from "../ui/sidebar-state.js";
import { LanguageSwitch } from "./language-switch.js";
import { ThemeToggle } from "./theme.js";

export type ShellSection = "overview" | "reviews" | "settings";

const NAV = [
  ["overview", "/ui", LayoutDashboard],
  ["reviews", "/ui/reviews", GitPullRequest],
  ["settings", "/ui/settings", Settings],
] as const;

export function AppShell({
  current,
  title,
  crumbs,
  form,
  fill,
  returnTo,
  children,
}: {
  current: ShellSection;
  title: string;
  crumbs?: ReactNode;
  form?: { method: "get" | "post"; action: string };
  fill?: boolean;
  returnTo?: string;
  children: ReactNode;
}) {
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useMobileSidebar(sidebarRef);
  const { m } = useI18n();
  const labels = { overview: m.shell.overview, reviews: m.shell.reviews, settings: m.shell.settings };
  const active = current;
  const column = (
    <>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-b bg-background px-3 py-2">
        <button
          ref={toggleRef}
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-sidebar-toggle=""
          aria-label={m.shell.toggleSidebar}
          onClick={() => toggleNav(sidebarRef.current, toggleRef.current)}
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
          <h1 className="truncate text-base font-medium tracking-tight">{title}</h1>
        </div>
      </header>
        <main id="main" className={fill ? "min-h-0 min-w-0 flex-1 overflow-hidden" : "min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"}>
        {fill ? children : <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-10 p-4 md:p-6">{children}</div>}
      </main>
    </>
  );
  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background text-foreground">
      <a className="skip-link" href="#main">
        {m.shell.skip}
      </a>
      <button type="button" className="mobile-backdrop fixed inset-0 z-30 bg-black/40" aria-label={m.shell.closeMenu} onClick={closeMobile} />
      <aside
        ref={sidebarRef}
        tabIndex={-1}
        className="app-sidebar flex h-full shrink-0 flex-col border-r bg-background focus:outline-none"
        aria-label={m.shell.sidebar}
      >
        <div className="flex h-12 items-center px-3">
          <a href="/ui" className="flex min-w-0 items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={closeMobile}>
            <span className="brand-mark size-6 place-items-center text-sm font-medium">d</span>
            <span className="brand-name truncate text-sm font-medium">dureview</span>
          </a>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2" aria-label={m.shell.dashboard}>
          {NAV.map(([id, href, Icon]) => {
            const label = labels[id];
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
        <div className="border-t">
          <div className="sidebar-tools">
            <LanguageSwitch returnTo={returnTo ?? shellReturnTo(current)} />
            <ThemeToggle />
          </div>
        </div>
      </aside>
      {form ? (
        <form className="flex min-h-0 min-w-0 flex-1 flex-col" method={form.method} action={form.action}>
          {column}
        </form>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{column}</div>
      )}
    </div>
  );
}

function shellReturnTo(current: ShellSection): string {
  switch (current) {
    case "overview":
      return "/ui";
    case "reviews":
      return "/ui/reviews";
    case "settings":
      return "/ui/settings";
    default: {
      const _exhaustive: never = current;
      return _exhaustive;
    }
  }
}

function useMobileSidebar(sidebarRef: { current: HTMLElement | null }): void {
  useEffect(() => {
    const root = document.documentElement;
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const mobileQuery = window.matchMedia("(max-width: 767px)");
    const sync = () => {
      const concealed = mobileSidebarConcealed(mobileQuery.matches, root.dataset.mobileNav);
      sidebar.inert = concealed;
      if (concealed) sidebar.setAttribute("aria-hidden", "true");
      else sidebar.removeAttribute("aria-hidden");
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-mobile-nav"] });
    mobileQuery.addEventListener("change", sync);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || root.dataset.mobileNav !== "open" || !mobileQuery.matches) return;
      closeMobile();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      mobileQuery.removeEventListener("change", sync);
      window.removeEventListener("keydown", onKey);
      sidebar.inert = false;
      sidebar.removeAttribute("aria-hidden");
    };
  }, [sidebarRef]);
}

function toggleNav(sidebar: HTMLElement | null, toggle: HTMLButtonElement | null): void {
  const root = document.documentElement;
  if (!window.matchMedia("(min-width: 768px)").matches) {
    if (root.dataset.mobileNav === "open") {
      delete root.dataset.mobileNav;
      toggle?.focus();
      return;
    }
    root.dataset.mobileNav = "open";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => sidebar?.focus());
    });
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
  const root = document.documentElement;
  if (root.dataset.mobileNav !== "open") return;
  delete root.dataset.mobileNav;
  document.querySelector<HTMLButtonElement>("[data-sidebar-toggle]")?.focus();
}
