import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Finding } from "../types.js";
import { grepRepo, readRepoFile } from "./files.js";
import { ReviewDraft } from "./state.js";

const MAX_FINDINGS = 30;

/**
 * Read-only tools are replay-safe: a crash mid-call reruns them.
 * pi-durable 1.0 CodingTools left `read` unsafe by default, so these tools set the flag explicitly.
 * submit_review only writes the durable draft, which is safe to apply again with the same arguments.
 * Comment posting is not a tool. It runs in the review task's post phase and checks GitHub first.
 */
export const readRepoTool = defineTool({
  name: "read",
  description:
    "Read a text file in the pull request checkout. path is relative to the repository root. Optional offset (1-based line) and limit page through large files. Output is line-numbered.",
  parameters: Type.Object({
    path: Type.String({ description: "File path relative to the repository root" }),
    offset: Type.Optional(Type.Number({ description: "1-based line to start at" })),
    limit: Type.Optional(Type.Number({ description: "Maximum lines to return" })),
  }),
  replay: "safe",
  async execute(args, api, context) {
    const cwd = (await api.agent(context)).cwd;
    if (!cwd) throw new Error("Review checkout is not configured.");
    const text = await readRepoFile(cwd, args);
    return { content: [{ type: "text", text }] };
  },
});

export const grepRepoTool = defineTool({
  name: "grep",
  description:
    "Search file contents in the pull request checkout. pattern is a regular expression (or a literal if it is not valid). path is an optional relative directory or file. Skips .git, node_modules, and build output.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Regular expression to search for" }),
    path: Type.Optional(Type.String({ description: "Directory or file relative to the repository root" })),
  }),
  replay: "safe",
  async execute(args, api, context) {
    const cwd = (await api.agent(context)).cwd;
    if (!cwd) throw new Error("Review checkout is not configured.");
    const text = await grepRepo(cwd, args);
    return { content: [{ type: "text", text }] };
  },
});

export const submitReviewTool = defineTool({
  name: "submit_review",
  description:
    "Record the finished review. Call this exactly once. summary is the pull request overview. findings are inline comments; each needs a repository-relative path, a 1-based line in the head file, and why that line is wrong. Use an empty findings array when there is nothing real to report.",
  parameters: Type.Object({
    summary: Type.String({ description: "Short overview of what is wrong, or 'No findings.'" }),
    findings: Type.Array(
      Type.Object({
        path: Type.String({ description: "Path relative to the repository root" }),
        line: Type.Number({ description: "1-based line in the head revision" }),
        body: Type.String({ description: "Why this line is wrong" }),
      }),
      { maxItems: MAX_FINDINGS },
    ),
  }),
  replay: "safe",
  async execute(args, api, context) {
    const findings = normalizeFindings(args.findings);
    await api.commit(async (tx) => {
      const draft = await tx.doc(ReviewDraft, api.conversationId);
      draft.submitted = true;
      draft.summary = args.summary.slice(0, 20_000);
      draft.findings = findings;
    }, context);
    return {
      content: [{ type: "text", text: `Recorded ${findings.length} finding(s).` }],
      control: { terminate: true },
    };
  },
});

export const reviewTools = [readRepoTool, grepRepoTool, submitReviewTool];

function normalizeFindings(raw: Array<{ path: string; line: number; body: string }>): Finding[] {
  const findings: Finding[] = [];
  for (const finding of raw.slice(0, MAX_FINDINGS)) {
    const file = finding.path.replaceAll("\\", "/").replace(/^\.\//, "").trim();
    if (!file || file.startsWith("/") || file.split("/").includes("..")) {
      throw new Error(`Finding path must stay inside the repository: ${finding.path}`);
    }
    if (!Number.isInteger(finding.line) || finding.line < 1) {
      throw new Error(`Finding line must be a positive integer: ${finding.path}`);
    }
    const body = finding.body.trim();
    if (!body) throw new Error(`Finding at ${file}:${finding.line} is missing an explanation.`);
    findings.push({ path: file, line: finding.line, body: body.slice(0, 8_000) });
  }
  return findings;
}
