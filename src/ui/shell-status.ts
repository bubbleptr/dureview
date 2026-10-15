import type { CodexView } from "./list-model.js";

/** Runtime facts shown on Settings. Tokens stay in auth.json. */
export type ShellStatus = {
  version: string;
  uptime: string;
  provider: string;
  model: string;
  thinking: string;
  codex: CodexView;
  githubApp: boolean;
  githubToken: boolean;
};
