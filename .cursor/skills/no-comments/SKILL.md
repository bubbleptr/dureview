---
name: no-comments
description: Remove comments that restate code; keep only comments that explain why. Use before committing any code change.
---

# No comments

Scope: your diff against `main` (or the files you were asked to touch).

1. List every comment you added or touched in scope.
2. Delete a comment when it restates what the code does, narrates history ("added X", "changed from Y"), is a TODO without an owner/issue, or is commented-out code.
3. Prefer making the code say it: rename a variable/function, extract a well-named helper, or use a type instead of a comment.
4. Keep a comment only when it explains *why* something non-obvious is done, documents a constraint we cannot change (external API quirk, spec requirement, security reason), or is public API docs (JSDoc on exported functions).
5. A comment like "do not remove" / "IMPORTANT" must be backed by a test, type, or lint rule when cheap; otherwise keep it short and explain the reason.
6. Never silence a lint/TypeScript error with a suppression comment to pass checks; fix the cause.
7. In the PR description, note how many comments were removed.
