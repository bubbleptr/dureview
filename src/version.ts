import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
    join(process.cwd(), "package.json"),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
      // The bundled server lives under .output; the next candidate is the app root.
    }
  }
  return "unknown";
}

/** Package version baked from `package.json` next to `src/` or `dist/`. */
export const VERSION = readVersion();
