import { mkdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewArchive } from "../src/review/archive.js";
import { checkoutProtectionKey, cleanupCheckouts } from "../src/review/checkout.js";
import { tempDataDir } from "./support.js";

const DAY = 24 * 60 * 60 * 1000;

describe("checkout cleanup", () => {
  it("deletes a checkout older than the ttl and keeps a fresh one", async () => {
    const root = await tempDataDir();
    const oldSha = "a".repeat(40);
    const freshSha = "b".repeat(40);
    await mkdir(join(root, "acme", "demo", oldSha), { recursive: true });
    await mkdir(join(root, "acme", "demo", freshSha), { recursive: true });
    await utimes(join(root, "acme", "demo", oldSha), new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY));

    const removed = await cleanupCheckouts({ root, ttlMs: 30 * DAY, protectedKeys: new Set() });

    expect(removed).toEqual([`acme/demo/${oldSha}`]);
    await expect(stat(join(root, "acme", "demo", oldSha))).rejects.toThrow();
    await expect(stat(join(root, "acme", "demo", freshSha))).resolves.toBeTruthy();
  });

  it("keeps a directory whose review is still running", async () => {
    const data = await tempDataDir();
    const root = join(data, "checkouts");
    const runningSha = "c".repeat(40);
    const finishedSha = "d".repeat(40);
    await mkdir(join(root, "acme", "demo", runningSha), { recursive: true });
    await mkdir(join(root, "acme", "demo", finishedSha), { recursive: true });
    const archive = new ReviewArchive(join(data, "reviews.sqlite"));
    await archive.open();
    await archive.start(row("running-task", runningSha));
    await archive.start(row("finished-task", finishedSha));
    await archive.finish({
      taskId: "finished-task",
      owner: "acme",
      repo: "demo",
      number: 7,
      outcome: "completed",
      verdict: "clean",
      findingCount: 0,
      findings: [],
    });
    const running = await archive.runningCheckouts();
    archive.close();

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 0,
      protectedKeys: new Set(running.map((item) => checkoutProtectionKey(item.owner, item.repo, item.sha))),
    });

    expect(running).toEqual([{ taskId: "running-task", owner: "acme", repo: "demo", sha: runningSha }]);
    expect(removed).toEqual([`acme/demo/${finishedSha}`]);
    await expect(stat(join(root, "acme", "demo", runningSha))).resolves.toBeTruthy();
    await expect(stat(join(root, "acme", "demo", finishedSha))).rejects.toThrow();
  });

  it("does not follow a symlink out of the checkouts tree", async () => {
    const parent = await tempDataDir();
    const root = join(parent, "checkouts");
    const outside = join(parent, "outside");
    const sha = "e".repeat(40);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "keep.txt"), "stay\n");
    await mkdir(join(root, "acme", "demo"), { recursive: true });
    await symlink(outside, join(root, "acme", "demo", sha));

    const removed = await cleanupCheckouts({ root, ttlMs: 0, protectedKeys: new Set() });

    expect(removed).toEqual([]);
    await expect(stat(join(outside, "keep.txt"))).resolves.toBeTruthy();
    await expect(stat(join(root, "acme", "demo", sha))).resolves.toBeTruthy();
  });

  it("removes an unused checkout older than an hour even when the ttl is longer", async () => {
    const root = await tempDataDir();
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    const stale = "a".repeat(40);
    const recent = "b".repeat(40);
    const running = "c".repeat(40);
    await plant(root, stale, 10, now - 2 * hour);
    await plant(root, recent, 10, now - 10 * 60 * 1000);
    await plant(root, running, 10, now - 3 * hour);

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 30 * DAY,
      now,
      protectedKeys: new Set([checkoutProtectionKey("acme", "demo", running)]),
    });

    expect(removed).toEqual([`acme/demo/${stale}`]);
    await expect(stat(join(root, "acme", "demo", recent))).resolves.toBeTruthy();
    await expect(stat(join(root, "acme", "demo", running))).resolves.toBeTruthy();
  });

  it("deletes oldest inactive checkouts until the tree fits the size cap", async () => {
    const root = await tempDataDir();
    const now = Date.now();
    const oldest = "a".repeat(40);
    const middle = "b".repeat(40);
    const newest = "c".repeat(40);
    const running = "d".repeat(40);
    await plant(root, oldest, 400, now - 4_000);
    await plant(root, middle, 400, now - 3_000);
    await plant(root, newest, 400, now - 2_000);
    await plant(root, running, 400, now - 5_000);

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 30 * DAY,
      now,
      protectedKeys: new Set([checkoutProtectionKey("acme", "demo", running)]),
      maxBytes: 900,
    });

    expect(removed).toEqual([`acme/demo/${oldest}`, `acme/demo/${middle}`]);
    await expect(stat(join(root, "acme", "demo", newest))).resolves.toBeTruthy();
    await expect(stat(join(root, "acme", "demo", running))).resolves.toBeTruthy();
  });
});

async function plant(root: string, sha: string, bytes: number, mtimeMs: number): Promise<void> {
  const dir = join(root, "acme", "demo", sha);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "blob"), Buffer.alloc(bytes));
  const when = new Date(mtimeMs);
  await utimes(dir, when, when);
}

function row(taskId: string, sha: string) {
  return {
    taskId,
    owner: "acme",
    repo: "demo",
    number: 7,
    title: "Charge",
    sha,
    baseSha: "f".repeat(40),
    baseRef: "main",
    installationId: null,
    trigger: "opened",
  };
}
