# Agent notes

Before any user-facing UI work, read [`design.md`](design.md) and the Vercel
baseline it names: https://vercel.com/design.md

`design.md` states how dureview follows that baseline, which dashboard rules
override it, and the precedence order. Load it before changing layout, type,
color, copy, or empty states under `/ui`.

## Skills

Read the matching skill in `.cursor/skills/<name>/SKILL.md` before the work it covers:

- Any `.ts` or `.tsx` edit: `typescript-best-practices`.
- React or UI work: `react-best-practices`, plus `design.md` (already required above).
- Debugging or bug fixes: `principle-fix-root-causes`.
- Features or refactors: `principle-subtract-before-you-add` first.
- Before declaring done: `principle-prove-it-works` (run the build and tests; screenshots for UI).
- Before every commit: `no-comments` on your diff.
