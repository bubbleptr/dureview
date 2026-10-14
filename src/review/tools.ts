import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { grepRepo, readRepoFile } from "./files.js";
import { ReviewSubmissionSchema, parseReviewSubmission } from "./schema.js";
import { ReviewDraft } from "./state.js";

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
    "Record the finished review. Call this exactly once. verdict is block, fix_recommended, or clean. findings is empty when nothing real is wrong. Each finding needs a title, priority 0-3, type (bug, flag, or security) with a matching subtype, kind (bug, security, or investigate), category, path, start_line, end_line, body, trigger, and confidence from 0 to 1. cwe is a CWE id such as CWE-89 for a security finding, or null. suggestion is replacement code for that line range, or null.",
  parameters: ReviewSubmissionSchema,
  replay: "safe",
  async execute(args, api, context) {
    const review = parseReviewSubmission(args);
    await api.commit(async (tx) => {
      const draft = await tx.doc(ReviewDraft, api.conversationId);
      draft.submitted = true;
      draft.verdict = review.verdict;
      draft.verdictReason = review.verdictReason;
      draft.overallConfidence = review.overallConfidence;
      draft.checked = review.checked;
      draft.findings = review.findings;
    }, context);
    return {
      content: [{ type: "text", text: `Recorded ${review.findings.length} finding(s).` }],
      control: { terminate: true },
    };
  },
});

export const reviewTools = [readRepoTool, grepRepoTool, submitReviewTool];
