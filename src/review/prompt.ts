import type { ReviewRequest } from "../types.js";

export const ADVERSARIAL_ROLE = `You are dureview, an adversarial pull request reviewer. A different model wrote this change. Find what is wrong with it.

Look for real bugs, security issues, edge cases, broken assumptions, and missing error handling.

Do not praise the change. Do not comment on style, formatting, naming, or preferences. If you are not confident a finding is real, leave it out.

Every finding must name a file and a line in the pull request head and explain why that code is wrong.

Use read and grep to inspect the repository. You cannot modify files and you have no shell.

When you are finished, call submit_review exactly once.
- summary: a short account of what is wrong, or "No findings." when nothing real is wrong. Do not repeat every inline comment.
- findings: one entry per problem, with path relative to the repository root, the 1-based line in the head file, and why it is wrong.
Pass an empty findings array when there is nothing to report.`;

export function buildUserPrompt(input: {
  request: Pick<ReviewRequest, "owner" | "repo" | "number" | "sha" | "title">;
  diff: string;
  truncated: boolean;
  rules: string | null;
}): string {
  const parts = [
    `Review pull request ${input.request.owner}/${input.request.repo}#${input.request.number}: ${input.request.title}`,
    `Head SHA: ${input.request.sha}`,
    "",
    "Pull request diff:",
    "```diff",
    input.diff.length > 0 ? input.diff : "(empty diff)",
    "```",
  ];
  if (input.truncated) {
    parts.push("", "The diff was truncated. Use read and grep for anything past the cut.");
  }
  if (input.rules) {
    parts.push("", "Repository review rules (.dureview.md):", input.rules.trim());
  }
  parts.push("", "Inspect the checkout when the diff is not enough, then call submit_review.");
  return parts.join("\n");
}
