import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const port = Number(process.env.DUREVIEW_PORT ?? 8787);
const host = process.env.DUREVIEW_HOST ?? "0.0.0.0";

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
    external: ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord"],
  },
  plugins: process.env.VITEST
    ? []
    : [
        tanstackStart({
          server: { entry: "server-entry.ts" },
          prerender: { enabled: false },
          importProtection: { behavior: "error" },
        }),
        nitro(),
        tailwindcss(),
        viteReact(),
      ],
});
