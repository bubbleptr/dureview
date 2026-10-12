import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grepRepo, readRepoFile } from "../src/review/files.js";
import { FIXTURE_DIR } from "./support.js";

describe("read and grep", () => {
  it("reads and searches the fixture checkout", async () => {
    const text = await readRepoFile(FIXTURE_DIR, { path: "src/pay.ts" });
    expect(text).toContain("if (amount > 0)");
    const matches = await grepRepo(FIXTURE_DIR, { pattern: "capture" });
    expect(matches).toContain("src/pay.ts");
    expect(matches).toContain("gateway.capture");
  });

  it("refuses paths that leave the checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "dureview-root-"));
    const outside = await mkdtemp(join(tmpdir(), "dureview-out-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "ok.ts"), "export const ok = true;\n");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));

    await expect(readRepoFile(root, { path: "../secret.txt" })).rejects.toThrow(/escapes|ENOENT/);
    await expect(readRepoFile(root, { path: "link.txt" })).rejects.toThrow(/escapes/);
    await expect(readRepoFile(root, { path: "src/ok.ts" })).resolves.toContain("ok = true");
  });
});
