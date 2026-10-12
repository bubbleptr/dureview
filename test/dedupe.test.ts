import { afterEach, describe, expect, it } from "vitest";
import type { RepoCheckout } from "../src/review/checkout.js";
import { reviewKey } from "../src/types.js";
import { MemoryGitHub, openTestService, reviewRequest, SHA_A, SHA_B, tempDataDir } from "./support.js";

describe("SHA dedupe", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("enqueues one task per pull request head", async () => {
    const github = new MemoryGitHub();
    const checkout: RepoCheckout = {
      prepare: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        }),
    };
    const { service } = await openTestService({
      dataDir: await tempDataDir(),
      github,
      checkout,
      responses: [],
    });
    closers.push(() => service.close());

    const first = await service.enqueue(reviewRequest(SHA_A));
    const again = await service.enqueue(reviewRequest(SHA_A));
    const other = await service.enqueue(reviewRequest(SHA_B));

    expect(again.deduped).toBe(true);
    expect(again.taskId).toBe(first.taskId);
    expect(other.deduped).toBe(false);
    expect(other.taskId).not.toBe(first.taskId);
    expect(reviewKey(reviewRequest(SHA_A))).not.toBe(reviewKey(reviewRequest(SHA_B)));
    expect(github.comments).toHaveLength(0);
  });
});
