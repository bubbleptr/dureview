import type { Context } from "@earendil-works/chord";
import { afterEach, describe, expect, it } from "vitest";
import { taskMarker } from "../src/types.js";
import { hangUntilAbort, MemoryGitHub, openTestService, reviewRequest, scriptedReview, tempDataDir } from "./support.js";

describe("resume after a crash", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("posts exactly one comment when the process dies between generation and posting", async () => {
    const dataDir = await tempDataDir();
    const github = new MemoryGitHub();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const first = await openTestService({
      dataDir,
      github,
      responses: scriptedReview("charge() reports success without billing."),
      hooks: {
        beforePost: async (context: Context) => {
          markEntered();
          await hangUntilAbort(context);
        },
      },
    });
    closers.push(() => first.service.close());
    const queued = await first.service.enqueue(reviewRequest());
    await entered;
    expect(github.comments).toHaveLength(0);
    expect(github.reviews).toHaveLength(0);
    await first.service.close();
    closers.pop();

    const second = await openTestService({ dataDir, github, responses: [] });
    closers.push(() => second.service.close());
    const settled = await second.service.wait(queued.taskId);
    expect(settled.state.outcome.status).toBe("completed");
    expect(github.comments).toHaveLength(1);
    expect(github.reviews).toHaveLength(1);
    expect(github.comments[0]?.body).toContain(taskMarker(String(queued.taskId)));
    await second.service.close();
    closers.pop();

    const third = await openTestService({ dataDir, github, responses: [] });
    closers.push(() => third.service.close());
    third.service.harness.resume();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(github.comments).toHaveLength(1);
    expect(github.reviews).toHaveLength(1);
  });

  it("does not post again when the process dies after GitHub accepted the write", async () => {
    const dataDir = await tempDataDir();
    const github = new MemoryGitHub();
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const first = await openTestService({
      dataDir,
      github,
      responses: scriptedReview("charge() reports success without billing."),
      hooks: {
        afterRemoteWrite: async (context: Context) => {
          markEntered();
          await hangUntilAbort(context);
        },
      },
    });
    closers.push(() => first.service.close());
    const queued = await first.service.enqueue(reviewRequest());
    await entered;
    expect(github.comments).toHaveLength(1);
    expect(github.reviews).toHaveLength(1);
    await first.service.close();
    closers.pop();

    const second = await openTestService({ dataDir, github, responses: [] });
    closers.push(() => second.service.close());
    const settled = await second.service.wait(queued.taskId);
    expect(settled.state.outcome.status).toBe("completed");
    expect(github.comments).toHaveLength(1);
    expect(github.reviews).toHaveLength(1);
    expect(settled.state.outcome.status === "completed" ? settled.state.outcome.result.summaryAction : "").toBe(
      "unchanged",
    );
  });
});
