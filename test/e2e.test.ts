import { createHmac } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startHttp } from "../src/server.js";
import { taskMarker } from "../src/types.js";
import {
  FINDING,
  MemoryGitHub,
  openTestService,
  pullPayload,
  scriptedReview,
  SECRET,
  SHA_A,
  SHA_B,
  tempDataDir,
} from "./support.js";

describe("end to end", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("reviews a fixture diff through the webhook and updates the summary on the next push", async () => {
    const github = new MemoryGitHub();
    const seen: string[] = [];
    const responses: FauxResponseStep[] = [
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxToolCall("read", { path: "src/pay.ts" }), { stopReason: "toolUse" });
      },
      ...scriptedReview("charge() reports success without billing.").slice(1),
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxToolCall("read", { path: "src/pay.ts" }), { stopReason: "toolUse" });
      },
      fauxAssistantMessage(fauxToolCall("grep", { pattern: "capture" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(
        fauxToolCall("submit_review", {
          summary: "The new push still skips the charge.",
          findings: [FINDING],
        }),
        { stopReason: "toolUse" },
      ),
    ];
    const { service } = await openTestService({
      dataDir: await tempDataDir(),
      github,
      responses,
    });
    const http = await startHttp(service, { host: "127.0.0.1", port: 0 });
    closers.push(async () => {
      await http.close();
      await service.close();
    });

    const health = await fetch(`${http.url}/health`);
    expect(health.status).toBe(200);

    const denied = await post(http.url, pullPayload(SHA_A), "nope");
    expect(denied.status).toBe(401);

    const opened = await post(http.url, pullPayload(SHA_A), SECRET);
    expect(opened.status).toBe(202);
    const firstBody = (await opened.json()) as { taskId: number; deduped: boolean };
    expect(firstBody.deduped).toBe(false);
    const first = await service.wait(firstBody.taskId as never);
    expect(first.state.outcome.status).toBe("completed");
    if (first.state.outcome.status !== "completed") return;
    expect(github.comments).toHaveLength(1);
    expect(github.reviews).toHaveLength(1);
    expect(github.comments[0]?.body).toContain("charge() reports success without billing.");
    expect(github.comments[0]?.body).toContain(taskMarker(String(firstBody.taskId)));
    expect(github.reviews[0]?.comments[0]).toMatchObject({ path: "src/pay.ts", line: 2 });
    expect(seen[0]).toContain("Flag success returned without calling the payment gateway.");
    expect(seen[0]).toContain("submit_review");
    expect(seen[0]).toContain("if (amount > 0)");

    const conversation = await service.harness.conversation(
      first.state.outcome.result.conversationId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    const entries = await conversation!.entries({ order: "ascending" }, 40, undefined, BACKGROUND_CONTEXT);
    const toolText = entries.items
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => {
        expect(message.isError).not.toBe(true);
        return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      })
      .join("\n");
    expect(toolText).toContain("if (amount > 0)");
    expect(toolText).toContain("gateway.capture");

    const duplicate = await post(http.url, pullPayload(SHA_A), SECRET);
    expect(duplicate.status).toBe(202);
    expect(((await duplicate.json()) as { deduped: boolean }).deduped).toBe(true);
    expect(github.comments).toHaveLength(1);

    const pushed = await post(http.url, pullPayload(SHA_B, "synchronize"), SECRET);
    expect(pushed.status).toBe(202);
    const secondBody = (await pushed.json()) as { taskId: number; deduped: boolean };
    expect(secondBody.deduped).toBe(false);
    const second = await service.wait(secondBody.taskId as never);
    expect(second.state.outcome.status).toBe("completed");
    expect(github.comments).toHaveLength(1);
    expect(github.comments[0]?.body).toContain("The new push still skips the charge.");
    expect(github.comments[0]?.body).toContain(taskMarker(String(secondBody.taskId)));
    expect(github.reviews).toHaveLength(2);
  });
});

function post(url: string, payload: Record<string, unknown>, secret: string): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return fetch(`${url}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    },
    body,
  });
}
