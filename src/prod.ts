import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";

/** Start the built TanStack Start server in this process. Dev uses `vite dev` instead. */
export async function startBuiltServer(config: Config): Promise<void> {
  if (!process.env.PORT) process.env.PORT = String(config.port);
  if (!process.env.HOST) process.env.HOST = config.host;
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", ".output", "server", "index.mjs");
  try {
    await access(file);
  } catch {
    throw new Error(
      `The TanStack Start server is not built (${file}). Run \`npm run build\` for production, or \`npm run dev\` for local development.`,
    );
  }
  await import(pathToFileURL(file).href);
}
