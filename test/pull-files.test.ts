import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubRest, parsePullFiles } from "../src/github/client.js";
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
    await expect(client.compareFiles(reviewRequest(), "main", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", new AbortController().signal)).rejects.toThrow(/SHA/);
  });
});
