import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../src/auth/store.js";

describe("credential store", () => {
  it("persists a refreshed token and serializes concurrent writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dureview-auth-"));
    const file = join(dir, "auth.json");
    const store = new FileCredentialStore(file);
    const credential = (access: string): OAuthCredential => ({
      type: "oauth",
      access,
      refresh: "refresh-token",
      expires: 1,
    });
    await store.modify("openai-codex", async () => credential("0"));

    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        store.modify("openai-codex", async (current) => {
          if (current?.type !== "oauth") throw new Error("missing credential");
          await new Promise((resolve) => setTimeout(resolve, 15));
          return credential(String(Number(current.access) + 1));
        }),
      ),
    );

    const reopened = new FileCredentialStore(file);
    const saved = await reopened.read("openai-codex");
    expect(saved).toMatchObject({ type: "oauth", access: "5", refresh: "refresh-token" });
    expect(await reopened.list()).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
  });
});
