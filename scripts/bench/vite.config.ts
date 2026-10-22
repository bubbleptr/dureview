import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function pageCsp(): Plugin {
  const source = readFileSync(resolve(repoRoot, "src/http/headers.ts"), "utf8");
  const match = source.match(/export const UI_CSP =\n\s*"([^"]+)"/);
  if (!match?.[1]) throw new Error("scripts/bench could not read UI_CSP from src/http/headers.ts");
  const policy = match[1].replace(/; frame-ancestors[^;]*/, "");
  return {
    name: "bench-csp",
    transformIndexHtml(html) {
      return html.replaceAll("__UI_CSP__", policy);
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [pageCsp(), tailwindcss(), react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        perf: resolve(here, "perf.html"),
        behaviors: resolve(here, "behaviors.html"),
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 8791,
    strictPort: true,
  },
});
