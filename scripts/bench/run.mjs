import { gzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { cpus, freemem, release, totalmem } from "node:os";
import { build, preview } from "vite";
import { chromium } from "playwright-core";

const repoRoot = join(import.meta.dirname, "../..");
const configFile = join(import.meta.dirname, "vite.config.ts");
const runs = numberArg("--runs", 5);
const port = numberArg("--port", 8791);
const fixtureNames = listArg("--fixtures", ["small", "large"]);
const chromePath = findChrome();

const browserInfo = {
  executable: chromePath,
  headless: true,
  viewport: { width: 1440, height: 900 },
};
const machine = {
  platform: process.platform,
  release: release(),
  arch: process.arch,
  node: process.version,
  cpu: cpus()[0]?.model ?? "unknown",
  cpuCount: cpus().length,
  memoryGiB: Math.round(totalmem() / 1024 / 1024 / 1024),
  freeMemoryGiB: Math.round(freemem() / 1024 / 1024 / 1024),
};

await build({ configFile, logLevel: "warn" });
const server = await preview({
  configFile,
  logLevel: "error",
  preview: { host: "127.0.0.1", port, strictPort: true },
});
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

let measurementError;

try {
  const version = browser.version();
  const fixtures = {};
  for (const name of fixtureNames) {
    const samples = [];
    for (let index = 0; index < runs + 1; index += 1) {
      const sample = await measureFixture(name);
      sample.warmup = index === 0;
      samples.push(sample);
      console.error(`${name} run ${index === 0 ? "warmup" : index}: highlight ${sample.highlight.highlightMs.toFixed(1)} ms`);
    }
    const measured = samples.filter((sample) => !sample.warmup);
    fixtures[name] = {
      meta: measured[0]?.meta ?? null,
      warmup: samples[0] ?? null,
      runs: measured,
      median: summarize(measured),
    };
  }
  const behaviors = await checkBehaviors();
  const bundles = measureBundles(join(repoRoot, ".output", "public"));
  const report = {
    measuredAt: new Date().toISOString(),
    machine,
    browser: { ...browserInfo, version },
    method: {
      runs,
      warmupDiscarded: 1,
      highlight: "performance marks from React render() to token spans on the first and last rendered line of every file",
      longTask: "PerformanceObserver longtask entries (>50ms) overlapping that interval",
      interaction: "in-page click, then busy time through the last overlapping long task or the following frame",
      bundles: bundles.measured
        ? "files under .output/public ending in .js or .wasm, gzip via zlib.gzipSync"
        : "production output .output/public was not present",
    },
    packageVersion: readPackageVersion(),
    fixtures,
    behaviors,
    bundles,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  measurementError = error;
} finally {
  try {
    await browser.close();
    await closePreview(server);
  } catch (error) {
    measurementError ??= error;
  }
}
if (measurementError) throw measurementError;

async function closePreview(server) {
  // Vite 8.3 PreviewServer.close() returns a promise. Node's http.Server.close only
  // accepts a callback, so a preview object without close() cannot be awaited.
  if (typeof server.close === "function") {
    await server.close();
    return;
  }
  await new Promise((resolve, reject) => {
    server.httpServer.close((error) => (error ? reject(error) : resolve()));
  });
}

async function measureFixture(name) {
  const page = await browser.newPage({ viewport: browserInfo.viewport });
  const errors = [];
  const failed = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) failed.push(`${response.status()} ${response.url()}`);
  });
  try {
    await page.goto(`${origin}/perf.html?fixture=${name}`, { waitUntil: "load", timeout: 120_000 });
    await page.waitForFunction(() => window.__bench?.highlightReady === true, null, { timeout: name === "large" ? 180_000 : 60_000 });
    const highlight = await page.evaluate(() => window.__bench.highlightResult());
    const meta = await page.evaluate(() => window.__bench.fixture);
    const theme = await page.evaluate(() => window.__bench.interact("theme"));
    const collapse = await page.evaluate(() => window.__bench.interact("collapse"));
    const expand = await page.evaluate(() => window.__bench.interact("expand"));
    const themeState = await page.evaluate(() => {
      const host = document.querySelector("diffs-container");
      const css = host instanceof HTMLElement ? (host.shadowRoot?.querySelector("[data-unsafe-css]")?.textContent ?? "") : "";
      return {
        darkClass: document.documentElement.classList.contains("dark"),
        hosts: [...document.querySelectorAll("diffs-container")].map((node) => node.getAttribute("data-theme")),
        annotation: document.body.innerText.includes("Skipped billing check"),
        findingCss: {
          hasLineRule: css.includes("[data-line="),
          hasDarkRule: css.includes(":host([data-theme=dark])"),
          hasBackground: css.includes("background:"),
        },
      };
    });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    if (failed.length > 0) throw new Error(`failed requests: ${failed.join(", ")}`);
    return { highlight, theme, collapse, expand, themeState, meta, errors };
  } catch (error) {
    const sample = await page.evaluate(() => window.__bench?.sample ?? "").catch(() => "");
    throw new Error(`${name} fixture failed: ${error instanceof Error ? error.message : String(error)}\n${errors.join("\n")}\n${failed.join("\n")}\nsample:\n${sample}`);
  } finally {
    await page.close();
  }
}

async function checkBehaviors() {
  const page = await browser.newPage({ viewport: browserInfo.viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const checks = {};
  try {
    await page.goto(`${origin}/behaviors.html#file-1`, { waitUntil: "load", timeout: 120_000 });
    await page.waitForFunction(() => {
      const folded = document.getElementById("file-1");
      const noted = document.querySelector("#file-0 diffs-container");
      return folded?.querySelector("button[aria-expanded='true']") != null && noted instanceof HTMLElement && noted.shadowRoot?.querySelector("[data-line] span[style*='--diffs-token'], [data-line] span[style*='color:']") != null;
    }, null, { timeout: 60_000 });
    checks.hashOpenedCollapsedFile = await page.evaluate(() => {
      const folded = document.getElementById("file-1");
      return folded?.querySelector("button[aria-expanded='true']") != null && folded.querySelector("diffs-container") != null;
    });
    checks.annotation = await page.evaluate(() => document.body.innerText.includes("Skipped billing check"));
    checks.findingCss = await page.evaluate(() => {
      const host = document.querySelector("diffs-container");
      const css = host instanceof HTMLElement ? (host.shadowRoot?.querySelector("[data-unsafe-css]")?.textContent ?? "") : "";
      return {
        hasLineRule: css.includes("[data-line="),
        hasDarkRule: css.includes(":host([data-theme=dark])"),
        hasBackground: css.includes("background:"),
      };
    });
    checks.sticky = await page.evaluate(() => {
      const panel = document.querySelectorAll(".review-panel")[1];
      const header = panel?.querySelector("section header");
      if (!(panel instanceof HTMLElement) || !(header instanceof HTMLElement)) return { ok: false, reason: "missing panel" };
      panel.scrollTop = 120;
      const panelTop = panel.getBoundingClientRect().top;
      const headerTop = header.getBoundingClientRect().top;
      return { ok: Math.abs(headerTop - panelTop) < 2, panelTop, headerTop, position: getComputedStyle(header).position };
    });
    const lightToken = await page.evaluate(() => {
      const span = document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line] span");
      return span instanceof HTMLElement ? getComputedStyle(span).color : "";
    });
    await page.getByRole("button", { name: "Toggle color scheme" }).click();
    await page.waitForFunction(() => {
      return document.documentElement.classList.contains("dark") && document.querySelector("diffs-container")?.getAttribute("data-theme") === "dark";
    });
    checks.dark = await page.evaluate((before) => {
      const host = document.querySelector("diffs-container");
      const css = host instanceof HTMLElement ? (host.shadowRoot?.querySelector("[data-unsafe-css]")?.textContent ?? "") : "";
      const span = document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-line] span");
      const after = span instanceof HTMLElement ? getComputedStyle(span).color : "";
      return {
        classDark: document.documentElement.classList.contains("dark"),
        dataTheme: [...document.querySelectorAll("diffs-container")].map((node) => node.getAttribute("data-theme")),
        lightToken: before,
        darkToken: after,
        tokenColorChanged: before !== after && before !== "" && after !== "",
        findingCss: {
          hasLineRule: css.includes("[data-line="),
          hasDarkRule: css.includes(":host([data-theme=dark])"),
          hasBackground: css.includes("background:"),
        },
      };
    }, lightToken);
    if (errors.length > 0) checks.pageErrors = errors;
    const failed = [];
    if (!checks.hashOpenedCollapsedFile) failed.push("hash did not open the collapsed file");
    if (!checks.annotation) failed.push("annotation text missing");
    if (!checks.findingCss?.hasLineRule || !checks.findingCss?.hasDarkRule) failed.push("finding line CSS missing");
    if (!checks.sticky?.ok) failed.push(`sticky header failed: ${JSON.stringify(checks.sticky)}`);
    if (!checks.dark?.classDark || checks.dark.dataTheme.some((value) => value !== "dark")) failed.push("dark mode did not reach the diff host");
    if (!checks.dark?.tokenColorChanged) failed.push(`token color did not change (${checks.dark?.lightToken} -> ${checks.dark?.darkToken})`);
    if (!checks.dark?.findingCss?.hasDarkRule) failed.push("dark finding CSS missing after theme toggle");
    if (failed.length > 0) throw new Error(failed.join("; "));
    return { ok: true, checks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`behavior checks failed: ${message}\n${errors.join("\n")}\n${JSON.stringify(checks)}`);
  } finally {
    await page.close();
  }
}

function summarize(samples) {
  return {
    highlightMs: median(samples.map((sample) => sample.highlight.highlightMs)),
    longTaskTotalMs: median(samples.map((sample) => sample.highlight.longTaskTotalMs)),
    longestTaskMs: median(samples.map((sample) => sample.highlight.longestTaskMs)),
    longTaskCount: median(samples.map((sample) => sample.highlight.longTaskCount)),
    themeBusyMs: median(samples.map((sample) => sample.theme.busyMs)),
    themeLongTaskTotalMs: median(samples.map((sample) => sample.theme.longTaskTotalMs)),
    themeLongestTaskMs: median(samples.map((sample) => sample.theme.longestTaskMs)),
    collapseBusyMs: median(samples.map((sample) => sample.collapse.busyMs)),
    collapseLongTaskTotalMs: median(samples.map((sample) => sample.collapse.longTaskTotalMs)),
    collapseLongestTaskMs: median(samples.map((sample) => sample.collapse.longestTaskMs)),
    expandBusyMs: median(samples.map((sample) => sample.expand.busyMs)),
    expandLongTaskTotalMs: median(samples.map((sample) => sample.expand.longTaskTotalMs)),
    expandLongestTaskMs: median(samples.map((sample) => sample.expand.longestTaskMs)),
    wasmCompiles: median(samples.map((sample) => sample.highlight.wasmCompiles)),
    tokenSpans: median(samples.map((sample) => sample.highlight.tokenSpans)),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return null;
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function measureBundles(dir) {
  if (!existsSync(dir)) return { measured: false, reason: `${dir} does not exist. Run npm run build first.` };
  const files = walk(dir).filter((file) => /\.(js|mjs|wasm)$/.test(file) && !file.endsWith(".map"));
  const rows = files.map((file) => {
    const bytes = readFileSync(file);
    return {
      file: relative(dir, file),
      raw: bytes.length,
      gzip: gzipSync(bytes).length,
      wasm: file.endsWith(".wasm"),
    };
  });
  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
  const js = rows.filter((row) => !row.wasm);
  const wasm = rows.filter((row) => row.wasm);
  return {
    measured: true,
    js: { files: js.length, raw: sum(js, "raw"), gzip: sum(js, "gzip") },
    wasm: { files: wasm.length, raw: sum(wasm, "raw"), gzip: sum(wasm, "gzip") },
    rows: rows.sort((left, right) => right.raw - left.raw),
  };
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function readPackageVersion() {
  const file = join(repoRoot, "node_modules", "@pierre", "diffs", "package.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")).version;
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, "/usr/local/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome was not found. Set CHROME_PATH.");
  return found;
}

function listArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${flag} expects a comma-separated list`);
  return value.split(",").filter(Boolean);
}

function numberArg(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} expects a positive integer`);
  return value;
}
