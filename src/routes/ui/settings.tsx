import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "../../components/login-form.js";
import { SettingsForm } from "../../components/settings-form.js";
import { getSettingsPage } from "../../ui/settings-fn.js";
import { getShellStatus } from "../../ui/shell-fn.js";

export const Route = createFileRoute("/ui/settings")({
  server: {
    handlers: {
      GET: async ({ request, next }) => {
        const { guardListGet } = await import("../../http/page-guard.js");
        const blocked = await guardListGet(request);
        if (blocked) return blocked;
        return next();
      },
      POST: async ({ request }) => {
        const { getRuntime } = await import("../../app/runtime.js");
        const { settingsPostResponse } = await import("../../http/settings.js");
        const runtime = await getRuntime();
        return settingsPostResponse(runtime.service, runtime.config.uiToken, request);
      },
    },
  },
  loader: async () => {
    const data = await getSettingsPage();
    if (data.kind !== "page") return { ...data, status: null };
    return { ...data, status: await getShellStatus() };
  },
  head: () => ({
    meta: [{ title: "Settings · dureview" }],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const data = Route.useLoaderData();
  if (data.kind === "login") return <LoginForm next={data.next} />;
  return <SettingsForm model={data.model} status={data.status} />;
}
