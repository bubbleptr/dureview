import { createServerFn } from "@tanstack/react-start";
import type { ShellStatus } from "../components/app-shell.js";

export type { ShellStatus };

/** Public status line already shown on the review list. Tokens stay in auth.json. */
export const getShellStatus = createServerFn({ method: "GET" }).handler(async (): Promise<ShellStatus | null> => {
  const { getRequest } = await import("@tanstack/react-start/server");
  const { getRuntime, listContext } = await import("../app/runtime.js");
  const { uiSession } = await import("../http/auth.js");
  const { loadDashboard } = await import("./status.js");
  const { codexPhrase, formatUptime } = await import("./page.js");
  const runtime = await getRuntime();
  const request = getRequest();
  if (uiSession(request, runtime.config.uiToken) !== "ok") return null;
  const ctx = listContext(runtime);
  const status = await loadDashboard({
    dataDir: ctx.dataDir,
    provider: ctx.provider,
    model: ctx.modelId,
    githubApp: ctx.githubApp,
    githubToken: ctx.githubToken,
    startedAt: ctx.startedAt,
  });
  return {
    version: status.version,
    uptime: formatUptime(status.uptimeSeconds * 1000),
    provider: status.provider,
    model: status.model,
    thinking: ctx.thinking,
    codex: codexPhrase(status.codex),
    githubApp: status.githubApp,
    githubToken: status.githubToken,
  };
});
