import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const port = Number(process.env.DUREVIEW_PORT ?? 8787);
const host = process.env.DUREVIEW_HOST ?? "0.0.0.0";

/**
 * pi-ai loads Codex OAuth through a variable dynamic import (`./openai-codex.js`).
 * Nitro's production server bundles dependencies into `.output/server/_libs`, and that
 * import then looks for a sibling chunk that was never emitted. Leave the packages
 * external so Node resolves them from `node_modules` (still present after
 * `npm prune --omit=dev`). The `*` suffix fully traces a package if Nitro copies it.
 */
const earendilRuntime = ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord"] as const;

export default defineConfig({
  server: {
    host,
    port: Number.isInteger(port) ? port : 8787,
    strictPort: true,
  },
  resolve: {
    tsconfigPaths: true,
  },
  ssr: {
    external: [...earendilRuntime],
  },
  environments: {
    nitro: {
      resolve: {
        external: [...earendilRuntime],
      },
    },
  },
  plugins: process.env.VITEST
    ? []
    : [
        tanstackStart({
          server: { entry: "server-entry.ts" },
          prerender: { enabled: false },
          importProtection: { behavior: "error" },
        }),
        nitro({
          traceDeps: earendilRuntime.map((name) => `${name}*`),
        }),
        tailwindcss(),
        viteReact(),
      ],
});
