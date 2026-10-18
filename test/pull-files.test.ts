import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPARE_FILE_CAP, GithubRest, parsePullFiles } from "../src/github/client.js";
import { reviewRequest, tempDataDir, testConfig } from "./support.js";

describe("pull request files", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops paths that escape the repository and keeps a missing patch", () => {
    expect(
      parsePullFiles([
        { filename: "src/pay.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n+x\n" },
        { filename: "../secrets.env", status: "added", additions: 1, deletions: 0, patch: "token" },
        { filename: "bin/app", status: "added", additions: 1, deletions: 0 },
      ]),
    ).toEqual([
      {
        filename: "src/pay.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1 +1 @@\n+x\n",
        previousFilename: null,
      },
      {
        filename: "bin/app",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: null,
        previousFilename: null,
      },
    ]);
    expect(() => parsePullFiles({ message: "nope" })).toThrow(/list/);
  });

  it("loads files with the GitHub App installation token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const config = testConfig(await tempDataDir());
    config.githubToken = undefined;
    config.githubAppId = "12345";
    config.githubAppPrivateKey = pem;
    const client = new GithubRest(config);
    const seen: Array<{ url: string; authorization: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      seen.push({ url, authorization });
      if (url.endsWith("/access_tokens")) {
        return Response.json({ token: "ghs_install_token_canary", expires_at: "2099-01-01T00:00:00Z" });
      }
      if (url.includes("/pulls/7/files")) {
        const link = url.includes("page=2")
          ? null
          : `<https://api.github.com/repos/acme/demo/pulls/7/files?page=2>; rel="next"`;
        return Response.json([{ filename: url.includes("page=2") ? "src/next.ts" : "src/pay.ts", status: "modified", additions: 1, deletions: 0, patch: "@@\n+x\n" }], {
          headers: link ? { link } : {},
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });

    const files = await client.listPullFiles(reviewRequest(), new AbortController().signal);
    expect(files.map((file) => file.filename)).toEqual(["src/pay.ts", "src/next.ts"]);
    const tokenCall = seen.find((call) => call.url.endsWith("/access_tokens"));
    const fileCalls = seen.filter((call) => call.url.includes("/pulls/7/files"));
    expect(tokenCall?.authorization.startsWith("Bearer ")).toBe(true);
    expect(fileCalls).toHaveLength(2);
    expect(fileCalls[0]?.authorization).toBe("Bearer ghs_install_token_canary");
    expect(fileCalls[0]?.authorization).not.toBe(tokenCall?.authorization);
  });

  it("compares the reviewed base and head instead of the live pull request", async () => {
    const config = testConfig(await tempDataDir());
    config.githubToken = "ghp_test";
    const client = new GithubRest(config);
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/compare/")) {
        return Response.json({
          files: [{ filename: "src/then.ts", status: "modified", additions: 1, deletions: 0, patch: "@@\n+reviewed\n" }],
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });

    const files = await client.compareFiles(reviewRequest(), "1111111111111111111111111111111111111111", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", new AbortController().signal);
    expect(files.map((file) => file.filename)).toEqual(["src/then.ts"]);
    expect(seen.some((url) => url.endsWith("/repos/acme/demo/compare/1111111111111111111111111111111111111111...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe(true);
    expect(seen.some((url) => /\/compare\/[0-9a-f]{40}\.\.[0-9a-f]{40}(?:$|\?)/.test(url))).toBe(false);
    await expect(client.compareFiles(reviewRequest(), "main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", new AbortController().signal)).rejects.toThrow(/SHA/);
  });

  it("uses a three-dot compare and keeps the patch only when it is relative to the reviewed head", async () => {
    const base = "1111111111111111111111111111111111111111";
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const config = testConfig(await tempDataDir());
    config.githubToken = "ghp_test";
    const client = new GithubRest(config);
    const seen: string[] = [];
    let mergeBase = base;
    let includeMergeBase = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      seen.push(url);
      if (!url.includes("/compare/")) return new Response(`unexpected ${url}`, { status: 500 });
      return Response.json({
        ...(includeMergeBase ? { merge_base_commit: { sha: mergeBase } } : {}),
        files: [{ filename: "src/pay.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -2,1 +2,1 @@\n-old\n+new\n" }],
      });
    });

    const signal = new AbortController().signal;
    const relative = await client.compareSinceReview(reviewRequest(), base, head, signal);
    expect(relative?.files.map((file) => file.filename)).toEqual(["src/pay.ts"]);
    expect(relative?.capped).toBe(false);
    expect(seen.at(-1)).toBe(`https://api.github.com/repos/acme/demo/compare/${base}...${head}`);

    mergeBase = other;
    expect(await client.compareSinceReview(reviewRequest(), base, head, signal)).toBeNull();
    expect(seen.at(-1)).toBe(`https://api.github.com/repos/acme/demo/compare/${base}...${head}`);

    includeMergeBase = false;
    await expect(client.compareSinceReview(reviewRequest(), base, head, signal)).rejects.toThrow(/merge base/);
  });

  it("reports the compare file list as capped at 300 files", async () => {
    const base = "1111111111111111111111111111111111111111";
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const config = testConfig(await tempDataDir());
    config.githubToken = "ghp_test";
    const client = new GithubRest(config);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        merge_base_commit: { sha: base },
        files: Array.from({ length: COMPARE_FILE_CAP }, (_, index) => ({
          filename: `src/f${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n+x\n",
        })),
      }),
    );
    const diff = await client.compareSinceReview(reviewRequest(), base, head, new AbortController().signal);
    expect(diff?.capped).toBe(true);
    expect(diff?.files).toHaveLength(COMPARE_FILE_CAP);
  });

  it("pages review comments by 100 and leaves a truncated list unclassified", async () => {
    const config = testConfig(await tempDataDir());
    config.githubToken = "ghp_test";
    const client = new GithubRest(config);
    let commentGets = 0;
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      seen.push(url);
      if (!url.includes("/pulls/7/comments")) return new Response(`unexpected ${url}`, { status: 500 });
      commentGets += 1;
      const next = `https://api.github.com/repos/acme/demo/pulls/7/comments?page=${commentGets + 1}&per_page=100`;
      return Response.json([{ id: commentGets, body: "note", path: "src/pay.ts", line: 1 }], {
        headers: { link: `<${next}>; rel="next"` },
      });
    });
    const signal = new AbortController().signal;
    await expect(client.listReviewComments(reviewRequest(), signal, { threads: "required" })).rejects.toThrow(/truncated/);
    expect(commentGets).toBe(10);
    expect(seen[0]).toContain("/pulls/7/comments?per_page=100");
    const published = await client.listReviewComments(reviewRequest(), signal);
    expect(published).toHaveLength(10);
    expect(commentGets).toBe(20);
  });

  it("requires the thread lookup for adoption and still publishes when that lookup fails", async () => {
    const config = testConfig(await tempDataDir());
    config.githubToken = "ghp_test";
    const client = new GithubRest(config);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/pulls/7/comments")) {
        return Response.json([{ id: 7, body: "<!-- dureview:finding aaaaaaaaaaaa task -->", path: "src/pay.ts", line: 2 }]);
      }
      if (url.endsWith("/graphql")) return Response.json({ errors: [{ message: "thread lookup down" }] });
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    const signal = new AbortController().signal;
    const published = await client.listReviewComments(reviewRequest(), signal);
    expect(published).toEqual([
      expect.objectContaining({ id: 7, resolved: false, threadId: null }),
    ]);
    await expect(client.listReviewComments(reviewRequest(), signal, { threads: "required" })).rejects.toThrow(/thread lookup down/);
  });
});
