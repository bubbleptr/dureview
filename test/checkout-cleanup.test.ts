import { mkdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupCheckouts, taskStatusIsLive, taskUsesLegacyCheckout } from "../src/review/checkout.js";
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

    const removed = await cleanupCheckouts({ root, ttlMs: 30 * DAY, taskIsLive: async () => false });

    expect(removed).toEqual([`acme/demo/${oldSha}`]);
    await expect(stat(join(root, "acme", "demo", oldSha))).rejects.toThrow();
    await expect(stat(join(root, "acme", "demo", freshSha))).resolves.toBeTruthy();
  });

  it("keeps a live task's checkout and deletes a terminal one, including aborted", async () => {
    const root = await tempDataDir();
    const runningSha = "c".repeat(40);
    const finishedSha = "d".repeat(40);
    const abortedSha = "e".repeat(40);
    const legacySha = "f".repeat(40);
    await plant(root, `${runningSha}-live-task`, 10, Date.now());
    await plant(root, `${finishedSha}-done-task`, 10, Date.now());
    await plant(root, `${abortedSha}-aborted-task`, 10, Date.now());
    await plant(root, legacySha, 10, Date.now());
    const status = new Map<string, string>([
      ["live-task", "running"],
      ["done-task", "terminal"],
      ["aborted-task", "terminal"],
    ]);
    const asked: string[] = [];

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 0,
      taskIsLive: async (taskId) => {
        asked.push(taskId);
        return taskStatusIsLive(status.get(taskId));
      },
    });

    expect(taskStatusIsLive("terminal")).toBe(false);
    expect(taskStatusIsLive("running")).toBe(true);
    expect(taskStatusIsLive("completing")).toBe(true);
    expect(taskStatusIsLive(undefined)).toBe(false);
    expect(new Set(asked)).toEqual(new Set(["live-task", "done-task", "aborted-task"]));
    expect(new Set(removed)).toEqual(
      new Set([
        `acme/demo/${finishedSha}-done-task`,
        `acme/demo/${abortedSha}-aborted-task`,
        `acme/demo/${legacySha}`,
      ]),
    );
    await expect(stat(join(root, "acme", "demo", `${runningSha}-live-task`))).resolves.toBeTruthy();
    await expect(stat(join(root, "acme", "demo", `${finishedSha}-done-task`))).rejects.toThrow();
    await expect(stat(join(root, "acme", "demo", `${abortedSha}-aborted-task`))).rejects.toThrow();
    await expect(stat(join(root, "acme", "demo", legacySha))).rejects.toThrow();
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

    const removed = await cleanupCheckouts({ root, ttlMs: 0, taskIsLive: async () => false });

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
    await plant(root, `${stale}-stale-task`, 10, now - 2 * hour);
    await plant(root, `${recent}-recent-task`, 10, now - 10 * 60 * 1000);
    await plant(root, `${running}-live-task`, 10, now - 3 * hour);
    const live = new Set<string>();

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 30 * DAY,
      now,
      taskIsLive: async (taskId) => {
        if (taskId === "live-task") live.add(taskId);
        return live.has(taskId);
      },
    });

    expect(removed).toEqual([`acme/demo/${stale}-stale-task`]);
    expect(live.has("live-task")).toBe(true);
    await expect(stat(join(root, "acme", "demo", `${recent}-recent-task`))).resolves.toBeTruthy();
    await expect(stat(join(root, "acme", "demo", `${running}-live-task`))).resolves.toBeTruthy();
  });

  it("deletes oldest inactive checkouts until the tree fits the size cap", async () => {
    const root = await tempDataDir();
    const now = Date.now();
    const oldest = "a".repeat(40);
    const middle = "b".repeat(40);
    const newest = "c".repeat(40);
    const running = "d".repeat(40);
    await plant(root, `${oldest}-old-task`, 400, now - 4_000);
    await plant(root, `${middle}-mid-task`, 400, now - 3_000);
    await plant(root, `${newest}-new-task`, 400, now - 2_000);
    await plant(root, `${running}-live-task`, 400, now - 5_000);
    const checks: string[] = [];

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 30 * DAY,
      now,
      taskIsLive: async (taskId) => {
        checks.push(taskId);
        return taskId === "live-task";
      },
      maxBytes: 900,
    });

    expect(removed).toEqual([`acme/demo/${oldest}-old-task`, `acme/demo/${middle}-mid-task`]);
    expect(checks[0]).toBe("live-task");
    await expect(stat(join(root, "acme", "demo", `${newest}-new-task`))).resolves.toBeTruthy();
    await expect(stat(join(root, "acme", "demo", `${running}-live-task`))).resolves.toBeTruthy();
  });

  it("keeps a legacy sha directory only while a live task still matches it", async () => {
    const root = await tempDataDir();
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    await plant(root, sha, 10, Date.now() - 2 * 60 * 60 * 1000);
    await plant(root, other, 10, Date.now() - 2 * 60 * 60 * 1000);
    const asked: string[] = [];

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 30 * DAY,
      taskIsLive: async () => false,
      legacyIsLive: async (checkout) => {
        asked.push(checkout.sha);
        return checkout.sha === sha && checkout.owner === "acme" && checkout.repo === "demo";
      },
    });

    const legacy = { owner: "acme", repo: "demo", sha, full: join(root, "acme", "demo", sha) };
    expect(
      taskUsesLegacyCheckout(
        {
          input: { owner: "other", repo: "demo", sha: "f".repeat(40) },
          state: { status: "running", checkpoint: { checkoutDir: legacy.full } },
        },
        legacy,
      ),
    ).toBe(true);
    expect(taskUsesLegacyCheckout({ input: { owner: "acme", repo: "demo", sha }, state: { status: "terminal" } }, legacy)).toBe(
      false,
    );
    expect(new Set(asked)).toEqual(new Set([sha, other]));
    expect(removed).toEqual([`acme/demo/${other}`]);
    await expect(stat(join(root, "acme", "demo", sha))).resolves.toBeTruthy();
    await expect(stat(join(root, "acme", "demo", other))).rejects.toThrow();
  });

  it("reads liveness again immediately before the size-cap delete", async () => {
    const root = await tempDataDir();
    const now = Date.now();
    const sha = "a".repeat(40);
    const leaf = `${sha}-flip-task`;
    await plant(root, leaf, 400, now - 2 * 60 * 60 * 1000);
    let reads = 0;

    const removed = await cleanupCheckouts({
      root,
      ttlMs: 30 * DAY,
      now,
      maxBytes: 100,
      taskIsLive: async () => {
        reads += 1;
        return reads === 1;
      },
    });

    expect(reads).toBe(2);
    expect(removed).toEqual([`acme/demo/${leaf}`]);
    await expect(stat(join(root, "acme", "demo", leaf))).rejects.toThrow();
  });
});

async function plant(root: string, leaf: string, bytes: number, mtimeMs: number): Promise<void> {
  const dir = join(root, "acme", "demo", leaf);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "blob"), Buffer.alloc(bytes));
  const when = new Date(mtimeMs);
  await utimes(dir, when, when);
}
