import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { MemoryGitHub, SHA_B, openTestService, reviewRequest, scriptedReview, tempDataDir } from "./support.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

describe("output token cap", () => {
  it("sends 16000 on every call, then the saved override, and warns when a call stops for length", async () => {
    const caps: Array<number | undefined> = [];
    const note = (step: FauxResponseStep): FauxResponseStep => (context, options, state, model) => {
      caps.push(options?.maxTokens);
      return typeof step === "function" ? step(context, options, state, model) : step;
    };
    const { service, faux } = await openTestService({
      dataDir: await tempDataDir(),
      github: new MemoryGitHub(),
      fauxModels: [{ id: "faux-1", maxTokens: 128_000 }],
      responses: [
        note(fauxAssistantMessage("cut off", { stopReason: "length" })),
        ...scriptedReview("Nothing to change.", []).map(note),
      ],
    });
    closers.push(() => service.close());
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    closers.push(async () => {
      logged.mockRestore();
    });

    const queued = await service.enqueue(reviewRequest());
    expect((await service.wait(queued.taskId)).state.outcome.status).toBe("completed");
    expect(caps.length).toBeGreaterThan(1);
    expect(new Set(caps)).toEqual(new Set([16_000]));
    const warnings = logged.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("output token cap"))
      .map((line) => JSON.parse(line) as { level: string; taskId: string; entryId: string });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: "warn", taskId: String(queued.taskId) });
    expect(warnings[0]?.entryId).toEqual(expect.any(String));

    caps.length = 0;
    expect(await service.saveSettings({ maxOutputTokens: "4000" }, "ui")).toEqual({ ok: true });
    faux.setResponses(scriptedReview("Still nothing.", []).map(note));
    const again = await service.enqueue(reviewRequest(SHA_B));
    expect((await service.wait(again.taskId)).state.outcome.status).toBe("completed");
    expect(caps.length).toBeGreaterThan(0);
    expect(new Set(caps)).toEqual(new Set([4000]));
    const later = logged.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("output token cap"));
    expect(later).toHaveLength(1);
  });

  it("clamps the cap to the model's own output limit", async () => {
    const caps: Array<number | undefined> = [];
    const note = (step: FauxResponseStep): FauxResponseStep => (context, options, state, model) => {
      caps.push(options?.maxTokens);
      return typeof step === "function" ? step(context, options, state, model) : step;
    };
    const { service } = await openTestService({
      dataDir: await tempDataDir(),
      github: new MemoryGitHub(),
      fauxModels: [{ id: "faux-1", maxTokens: 4096 }],
      responses: scriptedReview("Nothing to change.", []).map(note),
    });
    closers.push(() => service.close());

    const queued = await service.enqueue(reviewRequest());
    expect((await service.wait(queued.taskId)).state.outcome.status).toBe("completed");
    expect(caps.length).toBeGreaterThan(0);
    expect(new Set(caps)).toEqual(new Set([4096]));
  });
});
