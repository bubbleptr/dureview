import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { getRuntime } from "./app/runtime.js";

function normalize(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
    return new Request(url, request);
  }
  return request;
}

const building = process.argv.includes("build") || process.env.npm_lifecycle_event === "build";
if (!building && !process.env.VITEST) {
  queueMicrotask(() => {
    void getRuntime().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  });
}

export default createServerEntry({
  async fetch(request, opts) {
    await getRuntime();
    return handler.fetch(normalize(request), opts);
  },
});
