# dureview design guidance

dureview follows Vercel's public [`design.md`](https://vercel.com/design.md) as its
brand and interface baseline. Read that document before designing, implementing,
or reviewing a user-facing dureview surface.

The canonical guidance is maintained by Vercel. It explains how agents should
use Geist typography, a monochrome visual system, shared grids, intentional
hierarchy, restrained surfaces, accessible interaction, responsive layouts, and
evidence-based visual review. Its companion article is
[How our agents build on-brand pages with design.md](https://vercel.com/blog/how-our-agents-build-on-brand-pages-with-design-md).

## dureview-specific interpretation

The baseline does not turn dureview into a Vercel marketing report or a generic
SaaS landing page. This is an operator console for pull-request review.

- Do not load Vercel CSS, fonts, or brand assets at runtime. The content
  security policy allows only same-origin resources. Translate the relevant
  patterns into `src/styles.css` and the installed shadcn/Tailwind components.
  Do not add a parallel `--vbg-*` token layer or a `vercel-brand.css` file.
- Keep the dureview wordmark. Do not place the Vercel wordmark or triangle on
  dashboard pages.
- Geist Sans owns prose, navigation, labels, controls, tables, KPIs, dates,
  counts, percentages, and durations. Geist Mono owns code, commands, paths,
  raw tokens, env var names, model ids, timestamps, and suggestion diffs. Set
  only the identifier in Mono, not the sentence around it.
- The page is one continuous canvas. Prefer alignment, type, and spacing before
  borders. Use a stat strip for peer metrics. Do not wrap every metric, chart,
  or table in a card. A border is earned by the sidebar, a form field, the
  login form, or a real content split such as the review file tree and diff.
- Charts are figures with a heading and a caption that says what the reader
  should notice and what the chart does not establish. Give chart data a
  semantic table alternative. Use one gray for a single series. Use distinct
  grays only when a chart has more than one series. Bar length encodes the
  value on a shared scale.
- Tables are for lookup. Text columns and their headers align left. Numeric
  columns and their headers align right. Use tabular numerals. A wide ledger
  may scroll inside the table instead of shrinking the page.
- Color is reserved for review state, and it is always paired with text:
  pass, suggest, blocker (P0/P1), error, and running. Priority labels P0–P3
  may use the same restrained hues. Do not color a number merely because it is
  favorable, expensive, or large.
- Dashboard copy is English and sentence case. The login form stays Chinese:
  the title and submit button are `登录`, and a bad token says `token 不正确`.
  Do not add tracked uppercase eyebrows or decorative section numbers.
- Empty, loading, and error states are short sentences. A loading chart says
  what is loading. An error uses `role="alert"` and is not color alone.
- The explicit theme control is a settled product decision. The choice is
  stored in `localStorage` and applied before first paint. The canonical guide
  prefers an implicit theme; dureview keeps the control so operators can work
  in either theme without a flash on reload.
- The sidebar lists Overview, Reviews, and Settings. Overview is `/ui` and is
  only metrics: the counts, charts, token usage, and findings distribution that
  used to live on `/ui/stats`. `GET /ui/stats` redirects to `/ui`. Reviews is
  `/ui/reviews` and is only the review list. Settings is only settings. The
  sidebar collapses on a wide screen and becomes a sheet on a narrow one. Its
  footer keeps the theme control, version, uptime, model, ChatGPT login expiry,
  and GitHub credential status. Repo and time-range filters sit in the page
  they apply to, not in the top bar. The top bar is the sidebar control, the
  page title, and a breadcrumb when the review detail page has one.
- Keep URL filters (`repo`, `result`, `since`, `from`, `to`, `q` on the review
  list; `range`, `repo`, and `tz` on the overview), auth, and server functions.
  Client-only `sort`, `dir`, and `page` must not change those queries' meaning.
  `GET /ui/stats` redirects to `/ui` and keeps the query string.

## Precedence

Apply guidance in this order:

1. The user's explicit request and settled product decisions, including auth,
   URL filter behavior, Chinese login copy, review-result colors, and the
   persisted theme control.
2. Repository `AGENTS.md` instructions.
3. This dureview interpretation.
4. The canonical Vercel `design.md` baseline.

When two sources appear to conflict, preserve factual correctness,
accessibility, and established review behavior. Do not invent backend semantics
to make a layout easier.
