import { useLayoutEffect } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { applySavedAppearance, THEME_BOOT } from "../components/theme.js";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "robots", content: "noindex" },
      { title: "dureview" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  notFoundComponent: () => <p className="p-6 text-sm text-muted-foreground">Not found.</p>,
});

function RootComponent() {
  useLayoutEffect(() => {
    applySavedAppearance();
  }, []);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
