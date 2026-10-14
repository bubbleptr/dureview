import { Moon, Sun } from "lucide-react";

/** Blocking head script. Runs before paint so the saved theme does not flash. */
export const THEME_BOOT = `(function(){try{var r=document.documentElement;var t=localStorage.getItem("dureview-theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";if(localStorage.getItem("dureview-sidebar")==="collapsed")r.dataset.sidebar="collapsed";}catch(e){}})();`;

export function applySavedAppearance(): void {
  try {
    const root = document.documentElement;
    const stored = localStorage.getItem("dureview-theme");
    const dark = stored === "dark" || (stored !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    if (localStorage.getItem("dureview-sidebar") === "collapsed") root.dataset.sidebar = "collapsed";
  } catch {
    // Storage can be blocked. The page stays on the default light palette.
  }
}

export function ThemeToggle() {
  return (
    <button
      type="button"
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label="Toggle color scheme"
      onClick={() => {
        const root = document.documentElement;
        const next = root.classList.contains("dark") ? "light" : "dark";
        root.classList.toggle("dark", next === "dark");
        root.style.colorScheme = next;
        localStorage.setItem("dureview-theme", next);
      }}
    >
      <Sun className="hidden size-4 dark:block" />
      <Moon className="size-4 dark:hidden" />
    </button>
  );
}
