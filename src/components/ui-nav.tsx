const LINKS = [
  ["reviews", "/ui", "Reviews"],
  ["stats", "/ui/stats", "Statistics"],
  ["settings", "/ui/settings", "Settings"],
] as const;

export function UiNav({ current }: { current?: "reviews" | "stats" | "settings" }) {
  return (
    <nav className="flex items-center gap-3 text-sm">
      {LINKS.map(([id, href, label]) => (
        <a
          key={id}
          className={current === id ? "font-medium" : "text-muted-foreground underline-offset-4 hover:underline"}
          href={href}
          aria-current={current === id ? "page" : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
