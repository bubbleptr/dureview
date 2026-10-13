import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { startFixtureGit } from "./test/git-http.js";

const cached = (globalThis as { __dureviewGit?: { base: string; sha: string } }).__dureviewGit;
const git = cached ?? (await startFixtureGit());
(globalThis as { __dureviewGit?: { base: string; sha: string } }).__dureviewGit = git;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          DUREVIEW_WEBHOOK_SECRET: "test-webhook-secret",
          GITHUB_TOKEN: "test-token",
          MODEL_PROVIDER: "faux",
          MODEL_ID: "faux-1",
          MODEL_BASE_URL: "https://api.deepseek.com",
          MODEL_API_KEY: "test-model-key",
          DUREVIEW_THINKING: "off",
          DUREVIEW_DEFAULT_TRIGGER: "manual",
          DUREVIEW_TEST_HOOKS: "1",
          GITHUB_MODE: "memory",
          GIT_CLONE_BASE: git.base,
          FIXTURE_SHA: git.sha,
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
