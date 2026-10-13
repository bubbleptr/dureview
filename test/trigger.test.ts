import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.js";
import type { RemotePull } from "../src/github/client.js";
import { startHttp } from "../src/server.js";
import type { RepoCheckout } from "../src/review/checkout.js";
import { DureviewService } from "../src/service.js";
import { shouldReviewPull } from "../src/review/trigger.js";
import {
  BASE_SHA,
  MemoryGitHub,
  openTestService,
  pullPayload,
  SECRET,
  SHA_A,
  SHA_B,
  tempDataDir,
} from "./support.js";

const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";
const SHA_D = "dddddddddddddddddddddddddddddddddddddddd";

describe("pull request trigger", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("reviews every auto action and skips drafts until ready_for_review", async () => {
    const { service, github } = await open({ "main\0.dureview.md": front("auto") });
    for (const [action, sha] of [
      ["opened", SHA_A],
      ["synchronize", SHA_B],
      ["reopened", SHA_C],
      ["ready_for_review", SHA_D],
    ] as const) {
      const response = await deliver(service, "pull_request", pull(sha, action));
      expect(response.status).toBe(202);
      expect(response.body.deduped).toBe(false);
    }
    expect(github.fileRefs).toEqual(["main", "main", "main", "main"]);

    const draft = await deliver(service, "pull_request", pull(SHA_A, "opened", { draft: true }));
    expect(draft).toMatchObject({ status: 200, body: { ignored: true, reason: "draft" } });

    const ready = await deliver(service, "pull_request", pull(SHA_A, "ready_for_review"));
    expect(ready.status).toBe(202);
    expect(ready.body.deduped).toBe(true);
  });

  it("reviews a draft when drafts is true, unless the operator forces a skip", async () => {
    const allowed = await open({ "main\0.dureview.md": front("auto", true) });
    const opened = await deliver(allowed.service, "pull_request", pull(SHA_A, "opened", { draft: true }));
    expect(opened.status).toBe(202);

    const forced = await open({ "main\0.dureview.md": front("auto", true) }, { skipDrafts: true });
    const skipped = await deliver(forced.service, "pull_request", pull(SHA_A, "opened", { draft: true }));
    expect(skipped).toMatchObject({ status: 200, body: { ignored: true, reason: "draft" } });
    const ready = await deliver(forced.service, "pull_request", pull(SHA_B, "ready_for_review"));
    expect(ready.status).toBe(202);
    expect(ready.body.deduped).toBe(false);
  });

  it("reviews once on open, or on ready_for_review when the open was a skipped draft", async () => {
    const first = await open({ "main\0.dureview.md": front("once") });
    expect((await deliver(first.service, "pull_request", pull(SHA_A, "opened"))).status).toBe(202);
    expect((await deliver(first.service, "pull_request", pull(SHA_B, "synchronize"))).body).toMatchObject({
      ignored: true,
      reason: "once",
    });
    expect((await deliver(first.service, "pull_request", pull(SHA_B, "reopened"))).body).toMatchObject({
      ignored: true,
      reason: "once",
    });
    expect((await deliver(first.service, "pull_request", pull(SHA_B, "ready_for_review"))).body).toMatchObject({
      ignored: true,
      reason: "once",
    });

    const draft = await open({ "main\0.dureview.md": front("once") });
    expect((await deliver(draft.service, "pull_request", pull(SHA_A, "opened", { draft: true }))).body).toMatchObject({
      ignored: true,
      reason: "draft",
    });
    expect((await deliver(draft.service, "pull_request", pull(SHA_A, "ready_for_review"))).status).toBe(202);
    expect((await deliver(draft.service, "pull_request", pull(SHA_B, "synchronize"))).body).toMatchObject({
      ignored: true,
      reason: "once",
    });
  });

  it("does not review pull request events when trigger is manual", async () => {
    const { service } = await open({ "main\0.dureview.md": front("manual") });
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"] as const) {
      const response = await deliver(service, "pull_request", pull(SHA_A, action));
      expect(response).toMatchObject({ status: 200, body: { ignored: true, reason: "manual" } });
    }
  });

  it("stays manual when the base branch has no .dureview.md or the file omits trigger", async () => {
    const missing = await open();
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"] as const) {
      const response = await deliver(missing.service, "pull_request", pull(SHA_A, action));
      expect(response).toMatchObject({ status: 200, body: { ignored: true, reason: "manual" } });
    }
    expect(missing.github.fileRefs).toEqual(["main", "main", "main", "main"]);

    const omitted = await open({ "main\0.dureview.md": "---\nlanguage: zh\ndrafts: true\n---\n" });
    const omittedOpen = await deliver(omitted.service, "pull_request", pull(SHA_A, "opened"));
    expect(omittedOpen).toMatchObject({ status: 200, body: { ignored: true, reason: "manual" } });
    const omittedDraft = await deliver(omitted.service, "pull_request", pull(SHA_A, "opened", { draft: true }));
    expect(omittedDraft).toMatchObject({ status: 200, body: { ignored: true, reason: "manual" } });

    const prose = await open({ "main\0.dureview.md": "Flag missing error handling.\n" });
    const proseOpen = await deliver(prose.service, "pull_request", pull(SHA_A, "opened"));
    expect(proseOpen).toMatchObject({ status: 200, body: { ignored: true, reason: "manual" } });

    missing.github.remotePull = remote(SHA_A);
    missing.github.permissions.set("alice", "write");
    const command = await deliver(missing.service, "issue_comment", comment("/dureview", 70));
    expect(command.status).toBe(202);
    expect(command.body.deduped).toBe(false);
  });

  it("uses DUREVIEW_DEFAULT_TRIGGER when the file omits trigger, and an explicit key still wins", async () => {
    const auto = await open({}, { defaultTrigger: "auto" });
    expect((await deliver(auto.service, "pull_request", pull(SHA_A, "opened"))).status).toBe(202);

    const omitted = await open({ "main\0.dureview.md": "---\ndrafts: true\n---\n" }, { defaultTrigger: "auto" });
    expect((await deliver(omitted.service, "pull_request", pull(SHA_A, "opened", { draft: true }))).status).toBe(202);

    const explicit = await open({ "main\0.dureview.md": front("manual") }, { defaultTrigger: "auto" });
    expect((await deliver(explicit.service, "pull_request", pull(SHA_A, "opened"))).body).toMatchObject({
      ignored: true,
      reason: "manual",
    });

    const once = await open({ "main\0.dureview.md": "Flag missing error handling.\n" }, { defaultTrigger: "once" });
    expect((await deliver(once.service, "pull_request", pull(SHA_A, "opened"))).status).toBe(202);
    expect((await deliver(once.service, "pull_request", pull(SHA_B, "synchronize"))).body).toMatchObject({
      ignored: true,
      reason: "once",
    });
  });

  it("reads trigger rules from the base branch, not the pull request head", async () => {
    const manualOnBase = await open({
      "main\0.dureview.md": front("manual"),
      [`${SHA_A}\0.dureview.md`]: front("auto", true),
    });
    const draftSkipped = await deliver(manualOnBase.service, "pull_request", pull(SHA_A, "opened", { draft: true }));
    expect(draftSkipped).toMatchObject({ status: 200, body: { ignored: true, reason: "draft" } });
    const manualSkipped = await deliver(manualOnBase.service, "pull_request", pull(SHA_B, "opened"));
    expect(manualSkipped).toMatchObject({ status: 200, body: { ignored: true, reason: "manual" } });
    expect(manualOnBase.github.fileRefs).toEqual(["main", "main"]);

    const autoOnBase = await open({
      "main\0.dureview.md": front("auto", true),
      [`${SHA_A}\0.dureview.md`]: front("manual"),
    });
    const reviewed = await deliver(autoOnBase.service, "pull_request", pull(SHA_A, "opened", { draft: true }));
    expect(reviewed.status).toBe(202);
    expect(autoOnBase.github.fileRefs).toEqual(["main"]);
  });

  it("skips a review when the base branch config cannot be parsed", async () => {
    const { service } = await open({ "main\0.dureview.md": "---\ntrigger: sometimes\n---\n" });
    const response = await deliver(service, "pull_request", pull(SHA_A, "opened"));
    expect(response).toMatchObject({ status: 200, body: { ignored: true, reason: "config" } });
  });

  it("honors /dureview from write, maintain, and admin, including on a draft", async () => {
    const { service, github } = await open({ "main\0.dureview.md": front("manual") });
    github.remotePull = remote(SHA_A, true);
    let commentId = 10;
    for (const permission of ["write", "maintain", "admin"]) {
      github.permissions.set("alice", permission);
      const response = await deliver(service, "issue_comment", comment("/dureview\nagain", commentId));
      expect(response.status).toBe(202);
      expect(response.body.deduped).toBe(false);
      commentId += 1;
    }
    expect(github.reactions).toEqual([
      { commentId: 10, content: "eyes" },
      { commentId: 11, content: "eyes" },
      { commentId: 12, content: "eyes" },
    ]);
    expect(github.fileRefs).toEqual([]);
    expect(github.calls).not.toContain("getRepoFile");
  });

  it("ignores /dureview without write permission and ignores the bot", async () => {
    const { service, github } = await open();
    github.remotePull = remote(SHA_A);
    github.permissions.set("alice", "admin");
    for (const permission of ["read", "triage", "none"]) {
      github.permissions.set("alice", permission);
      const response = await deliver(service, "issue_comment", comment("/dureview", 20));
      expect(response).toMatchObject({ status: 200, body: { ignored: true, reason: "permission" } });
    }
    expect(github.reactions).toEqual([]);
    expect(github.calls).not.toContain("getPull");

    github.calls.length = 0;
    github.permissions.set("dureview[bot]", "admin");
    const own = await deliver(service, "issue_comment", comment("/dureview", 21, "dureview[bot]"));
    expect(own).toMatchObject({ status: 200, body: { ignored: true, reason: "self" } });
    const ownCase = await deliver(service, "issue_comment", comment("/dureview", 22, "Dureview[bot]"));
    expect(ownCase).toMatchObject({ status: 200, body: { ignored: true, reason: "self" } });
    expect(github.reactions).toEqual([]);
    expect(github.calls).toContain("viewerLogin");
    expect(github.calls).not.toContain("collaboratorPermission");
  });

  it("dedupes a command per head SHA and comment id, and still reviews that SHA again for a new command", async () => {
    const { service, github } = await open({ "main\0.dureview.md": front("auto") });
    github.remotePull = remote(SHA_A);
    github.permissions.set("alice", "write");

    const opened = await deliver(service, "pull_request", pull(SHA_A, "opened"));
    expect(opened.status).toBe(202);
    const command = await deliver(service, "issue_comment", comment("/dureview", 30));
    expect(command.status).toBe(202);
    expect(command.body.deduped).toBe(false);
    expect(command.body.taskId).not.toBe(opened.body.taskId);

    const repeat = await deliver(service, "issue_comment", comment("/dureview", 30));
    expect(repeat.status).toBe(202);
    expect(repeat.body.deduped).toBe(true);
    expect(repeat.body.taskId).toBe(command.body.taskId);

    const again = await deliver(service, "issue_comment", comment(" /dureview ", 31));
    expect(again.status).toBe(202);
    expect(again.body.deduped).toBe(false);
    expect(again.body.taskId).not.toBe(command.body.taskId);
    expect(github.reactions.map((reaction) => reaction.commentId)).toEqual([30, 30, 31]);
  });

  it("lets a command satisfy once mode, and still forces a review after the automatic one", async () => {
    const commanded = await open({ "main\0.dureview.md": front("once") });
    commanded.github.remotePull = remote(SHA_A);
    commanded.github.permissions.set("alice", "admin");
    expect((await deliver(commanded.service, "issue_comment", comment("/dureview", 40))).status).toBe(202);
    expect((await deliver(commanded.service, "pull_request", pull(SHA_A, "opened"))).body).toMatchObject({
      ignored: true,
      reason: "once",
    });

    const automatic = await open({ "main\0.dureview.md": front("once") });
    automatic.github.remotePull = remote(SHA_A);
    automatic.github.permissions.set("alice", "admin");
    const opened = await deliver(automatic.service, "pull_request", pull(SHA_A, "opened"));
    const command = await deliver(automatic.service, "issue_comment", comment("/dureview", 41));
    expect(opened.status).toBe(202);
    expect(command.status).toBe(202);
    expect(command.body.deduped).toBe(false);
    expect(command.body.taskId).not.toBe(opened.body.taskId);
  });

  it("accepts an issue_comment delivery on the webhook route", async () => {
    const github = new MemoryGitHub();
    github.remotePull = remote(SHA_A);
    github.permissions.set("alice", "write");
    const { service } = await openTestService({
      dataDir: await tempDataDir(),
      github,
      checkout: hangingCheckout(),
    });
    const http = await startHttp(service, { host: "127.0.0.1", port: 0 });
    closers.push(async () => {
      await http.close();
      await service.close();
    });
    const body = JSON.stringify(comment("/dureview", 50));
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const response = await fetch(`${http.url}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      body,
    });
    expect(response.status).toBe(202);
    expect(github.reactions).toEqual([{ commentId: 50, content: "eyes" }]);
  });

  async function open(
    files: Record<string, string> = {},
    options: { skipDrafts?: boolean; defaultTrigger?: "auto" | "once" | "manual" } = {},
  ) {
    const github = new MemoryGitHub();
    for (const [key, value] of Object.entries(files)) github.files.set(key, value);
    const { service } = await openTestService({
      dataDir: await tempDataDir(),
      github,
      checkout: hangingCheckout(),
      skipDrafts: options.skipDrafts,
      defaultTrigger: options.defaultTrigger,
    });
    closers.push(() => service.close());
    return { service, github };
  }
});

describe("DUREVIEW_DEFAULT_TRIGGER", () => {
  it("defaults to manual and rejects unknown values", () => {
    expect(configFromEnv({}).defaultTrigger).toBe("manual");
    expect(configFromEnv({ DUREVIEW_DEFAULT_TRIGGER: "" }).defaultTrigger).toBe("manual");
    expect(configFromEnv({ DUREVIEW_DEFAULT_TRIGGER: "  " }).defaultTrigger).toBe("manual");
    expect(configFromEnv({ DUREVIEW_DEFAULT_TRIGGER: "auto" }).defaultTrigger).toBe("auto");
    expect(configFromEnv({ DUREVIEW_DEFAULT_TRIGGER: "once" }).defaultTrigger).toBe("once");
    expect(configFromEnv({ DUREVIEW_DEFAULT_TRIGGER: "manual" }).defaultTrigger).toBe("manual");
    expect(() => configFromEnv({ DUREVIEW_DEFAULT_TRIGGER: "sometimes" })).toThrow(/DUREVIEW_DEFAULT_TRIGGER/);
  });
});

describe("shouldReviewPull", () => {
  it("matches each trigger and draft combination", () => {
    expect(shouldReviewPull(input("auto", "synchronize"))).toEqual({ review: true, once: false });
    expect(shouldReviewPull(input("auto", "opened", { draft: true }))).toEqual({ review: false, reason: "draft" });
    expect(shouldReviewPull(input("auto", "ready_for_review"))).toEqual({ review: true, once: false });
    expect(shouldReviewPull(input("once", "opened"))).toEqual({ review: true, once: true });
    expect(shouldReviewPull(input("once", "synchronize"))).toEqual({ review: false, reason: "once" });
    expect(shouldReviewPull(input("once", "reopened"))).toEqual({ review: false, reason: "once" });
    expect(shouldReviewPull(input("once", "opened", { draft: true, drafts: true }))).toEqual({ review: true, once: true });
    expect(shouldReviewPull(input("manual", "ready_for_review"))).toEqual({ review: false, reason: "manual" });
    expect(shouldReviewPull(input("manual", "opened", { draft: true, drafts: true }))).toEqual({
      review: false,
      reason: "manual",
    });
    expect(shouldReviewPull(input("auto", "opened", { draft: true, drafts: true, forceSkipDrafts: true }))).toEqual({
      review: false,
      reason: "draft",
    });
  });
});

function input(
  trigger: "auto" | "once" | "manual",
  action: "opened" | "synchronize" | "reopened" | "ready_for_review",
  extra: { draft?: boolean; drafts?: boolean; forceSkipDrafts?: boolean } = {},
) {
  return {
    action,
    draft: extra.draft ?? false,
    trigger,
    drafts: extra.drafts ?? false,
    forceSkipDrafts: extra.forceSkipDrafts ?? false,
  };
}

function front(trigger: string, drafts = false): string {
  return `---\ntrigger: ${trigger}\ndrafts: ${drafts}\n---\n`;
}

function pull(sha: string, action: string, extra: { draft?: boolean; baseRef?: string } = {}): Record<string, unknown> {
  const payload = pullPayload(sha, action);
  const pullRequest = payload.pull_request as { draft: boolean; base: { ref: string } };
  if (extra.draft !== undefined) pullRequest.draft = extra.draft;
  if (extra.baseRef !== undefined) pullRequest.base.ref = extra.baseRef;
  return payload;
}

function remote(sha: string, draft = false): RemotePull {
  return {
    number: 7,
    title: "Charge positive amounts",
    draft,
    sha,
    baseSha: BASE_SHA,
    baseRef: "main",
  };
}

function comment(body: string, commentId: number, user = "alice"): Record<string, unknown> {
  return {
    action: "created",
    installation: { id: 99 },
    repository: {
      name: "demo",
      clone_url: "https://github.com/acme/demo.git",
      owner: { login: "acme" },
    },
    issue: { number: 7, pull_request: { url: "https://api.github.com/repos/acme/demo/pulls/7" } },
    comment: { id: commentId, body, user: { login: user } },
  };
}

function deliver(
  service: DureviewService,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: { taskId?: number; deduped?: boolean; ignored?: boolean; reason?: string } }> {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  return service.handleWebhook(raw, signature, event);
}

function hangingCheckout(): RepoCheckout {
  return {
    prepare: (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      }),
  };
}
