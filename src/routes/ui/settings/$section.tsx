import { createFileRoute, notFound } from "@tanstack/react-router";
import { LoginForm } from "../../../components/login-form.js";
import { SettingsForm } from "../../../components/settings-form.js";
import { settingsCopy, sectionDocumentTitle } from "../../../ui/settings-copy.js";
import { getSettingsPage } from "../../../ui/settings-fn.js";
import { isSettingsSection } from "../../../ui/settings-sections.js";
import { getShellStatus } from "../../../ui/shell-fn.js";

export const Route = createFileRoute("/ui/settings/$section")({
  server: {
    handlers: {
      GET: async ({ request, params, next }) => {
        if (!isSettingsSection(params.section)) {
          const { notFoundJson } = await import("../../../http/headers.js");
          return notFoundJson();
        }
        const { guardListGet } = await import("../../../http/page-guard.js");
        const blocked = await guardListGet(request);
        if (blocked) return blocked;
        return next();
      },
      POST: async ({ request }) => {
        const { getRuntime } = await import("../../../app/runtime.js");
        const { settingsPostResponse } = await import("../../../http/settings.js");
        const { getShellStatus } = await import("../../../ui/shell-fn.js");
        const runtime = await getRuntime();
        return settingsPostResponse(runtime.service, runtime.config.uiToken, request, await getShellStatus());
      },
    },
  },
  loader: async ({ params }) => {
    if (!isSettingsSection(params.section)) throw notFound();
    const data = await getSettingsPage();
    if (data.kind !== "page") return { ...data, status: null };
    return { ...data, status: await getShellStatus() };
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.kind === "page" ? sectionDocumentTitle(loaderData.section) : settingsCopy.loginTitle,
      },
    ],
  }),
  component: SettingsSectionPage,
});

function SettingsSectionPage() {
  const data = Route.useLoaderData();
  if (data.kind === "login") return <LoginForm next={data.next} />;
  return <SettingsForm model={data.model} status={data.status} section={data.section} />;
}
