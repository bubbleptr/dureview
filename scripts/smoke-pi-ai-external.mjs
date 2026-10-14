/**
 * Proves the Nitro server left @earendil-works external, then loads the Codex
 * provider and its OAuth derivation module from the built server's import path.
 * Also proves every stylesheet or script URL baked into the SSR bundle exists
 * under `.output/public` (client and SSR must hash global CSS the same way).
 * No network. Run from the repo root after `vite build`, and again after
 * `npm prune --omit=dev`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const serverDir = join(root, ".output", "server");
const serverEntry = join(serverDir, "index.mjs");
const packages = ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord"];

if (!existsSync(serverEntry)) {
  console.error(`Missing ${serverEntry}. Run \`npm run build\` first.`);
  process.exit(1);
}

const bundled = walk(join(serverDir, "_libs")).filter((file) => file.includes("@earendil-works"));
if (bundled.length > 0) {
  throw new Error(
    `Nitro bundled @earendil-works into _libs (${bundled.join(", ")}). pi-ai's lazy OAuth import cannot resolve from that chunk.`,
  );
}

const bundledText = serverSources(serverDir)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");
if (!bundledText.includes("@earendil-works/pi-ai")) {
  throw new Error("Built server does not keep a bare @earendil-works/pi-ai import.");
}
if (bundledText.includes("_libs/@earendil-works/openai-codex")) {
  throw new Error("Built server still references the missing _libs openai-codex chunk.");
}

for (const name of packages) {
  const installed = join(root, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(installed)) {
    throw new Error(`${name} is missing from production node_modules (${installed}). npm prune --omit=dev must keep it.`);
  }
}

// A module next to the server entry resolves packages the same way production does
// (traced `.output/server/node_modules`, then the install tree).
const probe = join(serverDir, "_pi-ai-smoke.mjs");
await writeFile(
  probe,
  `import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
const provider = openaiCodexProvider();
if (provider?.id !== "openai-codex") {
  throw new Error("Expected openai-codex provider, got " + (provider?.id ?? "nothing") + ".");
}
const oauth = provider.auth?.oauth;
if (!oauth?.toAuth) throw new Error("openai-codex provider has no oauth derivation.");
const derived = await oauth.toAuth({ type: "oauth", access: "smoke-token", refresh: "smoke-refresh", expires: 0 });
if (derived?.apiKey !== "smoke-token") throw new Error("OAuth derivation did not return the access token.");
const resolved = import.meta.resolve("@earendil-works/pi-ai/providers/openai-codex");
if (resolved.includes("/_libs/")) throw new Error("openai-codex provider resolved inside _libs: " + resolved);
console.log("openai-codex provider and OAuth derivation resolved from " + resolved);
`,
);
try {
  await import(pathToFileURL(probe).href);
} finally {
  await rm(probe, { force: true });
}

const publicDir = join(root, ".output", "public");
const assetRef = /["'`](\/assets\/[^"'`\s]+)["'`]/g;
const checked = new Set();
const missing = [];
for (const file of serverSources(serverDir)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(assetRef)) {
    const url = match[1];
    if (!url || checked.has(url) || !isStylesheetOrScript(url)) continue;
    checked.add(url);
    if (!existsSync(join(publicDir, url.slice(1)))) missing.push(`${url} (${file})`);
  }
}
if (missing.length > 0) {
  throw new Error(
    `SSR output references stylesheets or scripts missing from .output/public:\n${missing.join("\n")}`,
  );
}
console.log(`SSR stylesheet and script hrefs (${checked.size}) all exist in .output/public.`);

/** Hashed client bundles only. Skips route-rule globs such as `/assets/**`. */
function isStylesheetOrScript(url) {
  return /^\/assets\/[^?*{}]+?\.(?:css|js|mjs)$/.test(url);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function serverSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) serverSources(path, out);
    else if (name.endsWith(".mjs") || name.endsWith(".js") || name.endsWith(".cjs")) out.push(path);
  }
  return out;
}
