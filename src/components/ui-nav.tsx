export function UiNav({ current }: { current: "reviews" | "settings" }) {
  return (
    <nav className="flex items-center gap-3 text-sm">
      <a
        className={current === "reviews" ? "font-medium" : "text-muted-foreground underline-offset-4 hover:underline"}
        href="/ui"
        aria-current={current === "reviews" ? "page" : undefined}
      >
        Reviews
      </a>
      <a
        className={current === "settings" ? "font-medium" : "text-muted-foreground underline-offset-4 hover:underline"}
        href="/ui/settings"
        aria-current={current === "settings" ? "page" : undefined}
      >
        Settings
      </a>
    </nav>
  );
}
