import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "../../components/login-form.js";

export const Route = createFileRoute("/ui/login")({
  server: {
    handlers: {
      GET: async ({ request, next }) => {
        const { getRuntime } = await import("../../app/runtime.js");
        const { uiSession } = await import("../../http/auth.js");
        const { applyUiHeaders } = await import("../../http/page-guard.js");
        const { notFoundJson, redirectResponse } = await import("../../http/headers.js");
        const runtime = await getRuntime();
        if (!runtime.config.uiToken) return notFoundJson();
        if (uiSession(request, runtime.config.uiToken) === "ok") return redirectResponse("/ui");
        applyUiHeaders(401);
        return next();
      },
      POST: async ({ request }) => {
        const { getRuntime } = await import("../../app/runtime.js");
        const { notFoundJson } = await import("../../http/headers.js");
        const { loginPostResponse } = await import("../../http/login.js");
        const runtime = await getRuntime();
        if (!runtime.config.uiToken) return notFoundJson();
        return loginPostResponse(request, runtime.config.uiToken);
      },
    },
  },
  component: LoginPage,
});

function LoginPage() {
  return <LoginForm next="/ui" />;
}
