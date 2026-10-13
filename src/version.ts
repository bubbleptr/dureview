import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Package version baked from `package.json` next to `src/` or `dist/`. */
export const VERSION = readVersion();
