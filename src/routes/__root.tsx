import { useLayoutEffect } from "react";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { applySavedAppearance, THEME_BOOT } from "../components/theme.js";
import { I18nProvider, useI18n } from "../ui/i18n.js";
import { getUiLocale } from "../ui/locale-fn.js";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  loader: () => getUiLocale(),
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
  notFoundComponent: NotFound,
});

function RootComponent() {
  const { locale } = Route.useLoaderData();
  useLayoutEffect(() => {
    applySavedAppearance();
  }, []);
  return (
    <html lang={locale} className="h-dvh overflow-hidden" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <HeadContent />
      </head>
      <body className="h-dvh overflow-hidden bg-background font-sans text-foreground antialiased">
        <I18nProvider locale={locale}>
          <Outlet />
        </I18nProvider>
        <Scripts />
      </body>
    </html>
  );
}

function NotFound() {
  const { m } = useI18n();
  return <p className="p-6 text-sm text-muted-foreground">{m.notFound}</p>;
}
