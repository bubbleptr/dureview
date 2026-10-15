# dureview

dureview is a self-hosted pull request reviewer. It reads a GitHub pull request, checks out that commit, and asks a **different model family** (OpenAI GPT) to look for real bugs. By default it posts one inline comment per finding and no summary. Set `summary: true` in `.dureview.md` to also post the summary comment.

It is a **long-running single-tenant service**, not a fresh runner per pull request. ChatGPT subscription tokens refresh and rotate. An ephemeral job cannot write the new token back. dureview logs in once, keeps the credential on a persistent volume, and uses [Pi Durable](https://github.com/earendil-works/pi) (`@earendil-works/pi-durable`) so a crash resumes the review instead of starting over.

> **ChatGPT subscription use is at your own risk.** The Codex OAuth path signs in with a ChatGPT Plus/Pro subscription (the same login pi-ai uses). OpenAI's terms may restrict automated use of subscription accounts. You are responsible for complying with those terms. If you have an API key, set `DUREVIEW_PROVIDER=openai` and `OPENAI_API_KEY` instead.

## Quick start

Requires Node.js 22.19 or newer, git, and a GitHub App or personal access token. The default model is `gpt-5.5`, which pi-ai exposes on both the Codex subscription catalog and the OpenAI API catalog.

```bash
docker build -t dureview .
docker volume create dureview-data

# One-time ChatGPT subscription login. Choose device code in Docker.
docker run --rm -it -v dureview-data:/data dureview login

docker run --rm -p 8787:8787 -v dureview-data:/data \
  -e DUREVIEW_WEBHOOK_SECRET="$DUREVIEW_WEBHOOK_SECRET" \
  -e GITHUB_APP_ID="$GITHUB_APP_ID" \
  -e GITHUB_APP_PRIVATE_KEY="$GITHUB_APP_PRIVATE_KEY" \
  dureview serve
```

Or with Compose (see `.env.example`):

```bash
docker compose run --rm -it dureview login
docker compose up -d
```

`GET /health` returns `{"ok":true}`. Point a GitHub webhook at `POST /webhook`. `GET /` is a status page on that same port. It stays off until `DUREVIEW_UI_TOKEN` is set. See [Status page](#status-page).

Without Docker, local development uses Vite. Production is still one Node process: `npm start` loads the built TanStack Start server in-process.

```bash
npm ci

# Dev server (Vite). Default bind is 0.0.0.0:8787.
DUREVIEW_DATA_DIR=./data \
DUREVIEW_WEBHOOK_SECRET=replace-with-a-long-random-string \
GITHUB_TOKEN=github_pat_... \
DUREVIEW_UI_TOKEN=replace-with-a-long-random-string \
npm run dev

# Production process, same env. `npm start` is `node dist/cli.js serve`.
npm run build
DUREVIEW_DATA_DIR=./data \
DUREVIEW_WEBHOOK_SECRET=replace-with-a-long-random-string \
GITHUB_TOKEN=github_pat_... \
DUREVIEW_UI_TOKEN=replace-with-a-long-random-string \
npm start
```

`DUREVIEW_HOST` defaults to `0.0.0.0` and `DUREVIEW_PORT` defaults to `8787`. When `PORT` or `HOST` is already set (Fly sets `PORT`), the production process keeps those and does not overwrite them. The dev server follows `DUREVIEW_HOST` and `DUREVIEW_PORT` only.

Login once if you use the Codex provider instead of `OPENAI_API_KEY`:

```bash
DUREVIEW_DATA_DIR=./data node dist/cli.js login
```

Run **one process**. Pi Durable storage is not locked across processes. On Fly, keep a single machine and mount the SQLite volume at `/data` (`DUREVIEW_DATA_DIR=/data`). Do not run a second listener beside this process.

### TanStack Start skeleton

This tree serves HTTP with TanStack Start, React, and shadcn/ui. Nitro builds a Node server into `.output/server/index.mjs`. `dureview serve` imports that file in the same process. Docker still starts `node dist/cli.js serve`.

Migrated onto TanStack Start routes:

- `GET /health`
- `POST /webhook`, including `X-Hub-Signature-256` verification, then the existing pi-durable review enqueue
- `GET /` and `GET /ui` overview: counts, charts, token usage, and findings distribution. `GET /ui/stats` redirects here. See [Statistics](#statistics).
- `GET /ui/reviews` review list, React + shadcn, reading `$DUREVIEW_DATA_DIR/reviews.sqlite`
- `GET /ui/reviews/:taskId` review detail, React + shadcn, three columns (files, diff with inline findings, summary). The file list is `@pierre/trees` and the diff is `@pierre/diffs` (Shiki). The diff view is unified or split, chosen on the Settings page and saved in the browser. Files with no comments start collapsed. A file with comments shows about ten lines around each comment; the rest is an expandable hidden-line row that can be collapsed again. The file header collapses or expands the whole file. Placement still uses `src/ui/diff.ts`. The patch is still loaded live from GitHub when the page opens. A GitHub error leaves the saved comments on the page.
- `GET` and `POST /ui/settings`. The operator can change the model, thinking level, default trigger, draft skip, and checkout TTL without restarting or changing Fly secrets. See [Settings](#settings).
- `GET` and `POST /ui/login`. The cookie is still `dureview_ui`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 30 days. The value is `DUREVIEW_UI_TOKEN`. A successful login from `/` continues at `/ui`.

Not migrated yet:

- Codex `login` / `logout`, review execution, GitHub publishing, and the archive format
- Tests still boot an in-process `node:http` listener (`startHttp`) so they can call the same helpers without Vite. That listener is not the production server.

`npm run typecheck` and `npm test` pass on this branch. Production is still one Node process. On Fly, keep a single machine and the SQLite file at `/data`.

## Login

`dureview login` runs the OpenAI Codex (ChatGPT Plus/Pro) OAuth flow from `@earendil-works/pi-ai` and stores the credential in `$DUREVIEW_DATA_DIR/auth.json` (mode `0600`).

- **Browser login** opens a localhost callback. Use it on a machine with a browser.
- **Device code login** prints a URL and a code. Use this in Docker and on a server (`DUREVIEW_LOGIN_METHOD=device_code` skips the prompt).

pi-ai refreshes an expired access token inside the credential store's `modify` lock and writes the rotated refresh token back to `auth.json`. That only works because the data directory survives restarts. Do not bake `auth.json` into the image.

`dureview logout` deletes the Codex credential.

To use an API key instead:

```bash
docker run --rm -p 8787:8787 -v dureview-data:/data \
  -e DUREVIEW_PROVIDER=openai \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e DUREVIEW_WEBHOOK_SECRET="$DUREVIEW_WEBHOOK_SECRET" \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  dureview serve
```

The API key is read from the environment. It is not written to the data directory.

## GitHub

### GitHub App (preferred)

1. Create a GitHub App owned by the account that should review pull requests.
2. Permissions: **Contents** (read), **Pull requests** (read and write), **Issues** (read and write), **Checks** (read and write). Metadata is included.
3. Subscribe to the **Pull request** and **Issue comment** events.
4. Webhook URL: `https://<your-host>/webhook`. Webhook secret: the same value as `DUREVIEW_WEBHOOK_SECRET`.
5. Install the App on the repositories it should review.
6. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the PEM, with newlines as `\n`, or a path via `GITHUB_APP_PRIVATE_KEY_PATH`).

Issue comment events deliver `/dureview`. The 👀 reaction uses the Issues write permission. The collaborator permission check uses the App's access to the repository.

### Check runs

Every review, including one started by `/dureview`, opens a check run named `dureview` on the pull request head commit. It stays in progress while the review runs, then completes:

- No findings: **success**. The title is "No findings", or "未发现问题" when `language` is `zh`.
- A P0 or P1: **failure**. The summary lists how many findings are at each priority. Findings that were not posted inline (for example a line outside the diff, when `summary` is false) are listed under that count, so a failing check is explained on the commit even when the conversation has no comment.
- Only P2 and P3: **success**. The title is "N suggestions", or "有 N 条建议".
- The review itself fails (the model errors, times out, or throws): **failure**. A bad `.dureview.md` or an unknown model is **action required** instead, and the check links to the configuration section of this README. The summary is the error, and the check does not stay in progress.
- The task is aborted: **cancelled**.

A second review of the same commit completes any other in-progress `dureview` run on that SHA, so two overlapping reviews do not leave a spinning check. A transient Checks API error is retried. Only a 403 is treated as a missing permission: dureview logs it and continues, and does not remember that skip across a crash that happened before the check id was saved. If creating the check succeeded and the process stopped before the id was saved, the next attempt finds that run by its task id.

In branch protection, require the status check `dureview`. A success conclusion is a review that found nothing blocking. Failure and action required block the merge when the check is required.

The App needs **Checks: Read & write** for this. If GitHub returns 403, dureview logs that the App cannot write check runs and continues. Inline comments, request changes, summaries, and `/dureview` are unchanged.

The webhook payload includes `installation.id`. dureview mints a short-lived installation token for the API and for `git fetch`. The token is not stored.

dureview checks out `pull/<number>/head` from the repository that hosts the pull request, so fork pull requests work when the App can read that repository.

### Personal access token

Set `GITHUB_TOKEN` and omit the App variables. The token needs read access to the repository and permission to create issue comments and pull request reviews. The Checks API is what creates the `dureview` check run; a token that GitHub rejects with 403 still posts the review, and the miss is logged. Do not set `GITHUB_APP_ID` when using a token.

### What gets reviewed

dureview reads `.dureview.md` from the pull request's **base branch**, not from the pull request head. A pull request cannot change its own trigger rules, thresholds, or review prompt. Those updates apply after it merges. When the base branch has no `.dureview.md`, or the file does not set `trigger`, the effective trigger is `DUREVIEW_DEFAULT_TRIGGER` (`manual` by default) and `drafts` is `false`. Installing the GitHub App is not enough to start reviews: the repository opts in with `trigger: auto` or `trigger: once`, or the operator changes the server default.

`trigger: manual` reviews only when someone with write, maintain, or admin permission comments `/dureview`. `trigger: auto` reviews `pull_request` actions `opened`, `reopened`, `synchronize`, and `ready_for_review`. `trigger: once` reviews a pull request one time: on `opened`, or on `ready_for_review` when the pull request was still a draft at open and that open was skipped. Later pushes and a reopen do not start another review.

`drafts: false` (the default) skips draft pull requests. Marking a draft ready for review reviews the current head, unless `trigger` is `manual`. `drafts: true` reviews drafts the same way as open pull requests. `DUREVIEW_SKIP_DRAFTS=1` still skips drafts even when the file sets `drafts: true`.

A comment on the pull request whose first line is `/dureview` (leading and trailing whitespace ignored) always reviews the current head, including drafts and `manual` repositories. dureview ignores that command from its own GitHub App bot (`{slug}[bot]`, from `GET /app`) or from the personal access token user (`GET /user`). The author must have write, maintain, or admin permission; dureview checks the collaborator permission API and ignores anyone else, with no reaction. An accepted command gets a 👀 reaction. The same comment does not start two reviews of the same head SHA. A new `/dureview` comment does, even when that SHA was already reviewed. A command also counts as the one `trigger: once` review when that slot is still open, so a later open or ready-for-review does not start a second automatic review. The command itself still runs after the automatic review. Other events, including `ping` and comments that are not the command, are acknowledged and ignored.

The same `owner/repo#number@sha` is not reviewed twice by an automatic event. A later push (a new SHA) is a new review when `trigger` is `auto`. What it posts depends on `summary` in `.dureview.md` (default `false`).

With `summary: false`, dureview posts one inline comment per finding and nothing else. A review with no findings, and no earlier inline comment to resolve, writes nothing to the conversation. The `dureview` check run on the head commit still completes as success, which is how you can see that the review finished. It still reads existing inline comments so a finding that disappeared can be closed. A P0 or P1 inline finding submits the review as **Request changes**. Any other posted finding uses **Comment**. An informational flag never requests changes, even at P0. dureview does not approve. GitHub rejects Request changes when the token's user opened the pull request; dureview logs that and submits Comment instead. `investigate` findings and findings with an empty trigger are not posted. Informational flags are stored and are not posted unless `post_informational` is true. A finding that was posted before and is absent on the next push has its review thread resolved. If the thread cannot be resolved, dureview replies `fixed in <sha>` (or `已在 <sha> 修复` when `language` is `zh`).

With `summary: true`, a later push updates the existing summary comment. Inline comments are posted only for findings that were not already commented. A finding that disappears is marked fixed in the summary. The review event stays Comment.

## What the model sees

Each review is one Pi Durable task:

1. **prepare** checks out the head, loads the diff plus `.dureview.md` from the base branch, and opens the `dureview` check run on the head SHA.
2. **review** runs a conversation with `read`, `grep`, and `submit_review`. No write, edit, or shell tool is offered.
3. **post** publishes to GitHub and completes the check run. Titles and the summary follow `language`.

The default prompt is adversarial and disciplined. It looks for real bugs, security issues, edge cases, broken assumptions, and missing error handling, and it may record a suspicion it cannot prove. It does not praise the change or comment on style. Adapted from Codex's open review rubric, a finding has to be introduced by this pull request, name the code it affects, and come with a concrete trigger. Pre-existing bugs, intentional changes, and "this could be nicer" comments are out of scope.

`submit_review` returns one JSON document:

- `verdict`: `block`, `fix_recommended`, or `clean`, plus a short `verdict_reason`, an optional `overall_confidence` from 0 to 1, and up to six `checked` risk areas.
- `findings`: each has a title, `priority` `0`–`3` (P0–P3), `type` and `subtype`, `kind` (`bug`, `security`, or `investigate`), `category` (`correctness`, `security`, `data_integrity`, `concurrency`, `error_handling`, `performance`, `api_contract`, `test_gap`), `path`, `start_line`, `end_line`, `body`, `trigger`, `confidence`, and an optional `suggestion` that can replace that line range. `type` is orthogonal to priority: `bug` (`severe` or `non_severe`), `flag` (`investigate` or `informational`), or `security` (`critical` or `warning`). `evidence` lists `path:line` locations when another call site is affected. `cwe` is an optional id such as `CWE-89` on a security finding. `rule_ref` is optional. A payload that omits or garbles `type` or `subtype` is kept: the server fills them from `kind` and priority instead of rejecting the review.

The server computes `fingerprint` as the first 12 hex characters of SHA-256 over the path, category, and normalized title. The model does not choose it. That fingerprint is how a later push recognizes the same finding.

`read` and `grep` are marked `replay: "safe"` (pi-durable 1.0's built-in `read` tool is not). Comment posting is **not** replay-safe. The post phase reads what is already on the pull request before it writes. Hidden markers carry the task id and, when summary comments are off, the finding fingerprint:

```html
<!-- dureview:summary owner/repo#42 -->
<!-- dureview:task 17 -->
<!-- dureview:inline 17 -->
<!-- dureview:finding a1b2c3d4e5f6 17 -->
<!-- dureview:fixed a1b2c3d4e5f6 <sha> -->
```

The summary, task, and inline markers are used when `summary: true`. The finding marker is embedded in each inline comment when `summary: false`, and the fixed marker is embedded in a reply when a thread could not be resolved. If the process dies after GitHub accepted a write, resume sees the marker and does not post a second copy. The summary marker is per pull request, so the next push updates that comment instead of adding another.

Before anything is posted, the server drops findings below the confidence floor, skips lockfiles, generated files, binaries, and `dist/` (plus any globs in `.dureview.md`), and refuses paths outside the repository. `investigate` findings, P3 findings, and P2 findings under the P2 confidence bar are not inline. So are bug or security findings with an empty trigger. Informational flags are not posted unless `post_informational` is true, and they never make the review event `REQUEST_CHANGES`. A line range that does not overlap the diff is not inline either. Everything else can be an inline comment, at most `max_inline` per run, highest priority first. A GitHub suggestion block is included only when the suggestion replaces that exact diff range. Inline comments and the summary show the type next to the priority, for example `P1 · Bug (severe)` or `P0 · Security · Critical · CWE-89`.

When `summary: false` (the default), those non-inline findings are dropped. Nothing is posted when none of the findings are inline and no earlier dureview inline comment needs to be resolved. Inline comments are one pull request review on `side: RIGHT`. The event is `REQUEST_CHANGES` when any of those comments is P0 or P1 and is not an informational flag, and `COMMENT` otherwise. A multi-line finding sets `start_line`. The review body is empty. Each comment ends with the finding marker. On a later push, dureview reads existing inline comments, skips fingerprints that are already open, and calls GitHub's GraphQL `resolveReviewThread` for a fingerprint that is gone. If that mutation fails, or the thread id is missing, it replies on the comment instead.

When `summary: true`, non-inline findings go in the summary: `investigate`, missing triggers, P3, low-confidence P2, and out-of-range lines each have a collapsed section. The summary comment is updated in place. Its heading is the verdict (block, fix recommended, or clean), in the configured language. The body lists actionable findings by severity, then the collapsed sections, then what was checked. A clean review with no findings shows that checked list. Findings from the previous push that are gone are listed as fixed. The inline review uses `event: COMMENT`. Its body records the fingerprints that were posted, so a later push does not comment on them again. Labels, verdict words, and the fixed note follow `language` in both modes. The model is told to write finding titles, bodies, triggers, the verdict reason, and the checked list in that language.

## `.dureview.md`

Optional file at the repository root. dureview reads it from the pull request's base branch, not from the pull request head, so a pull request cannot change how it is reviewed. Prose after the optional front matter is appended to the review prompt. The front matter overrides the posting thresholds and the trigger rules. Keys you do not set keep the profile's defaults, except `trigger`, which uses `DUREVIEW_DEFAULT_TRIGGER` (`manual`) when the key is absent. An explicit key wins over the profile and over that server default. Set `trigger: auto` or `trigger: once` to opt in to automatic reviews.

```markdown
---
profile: default
# Omit trigger to use DUREVIEW_DEFAULT_TRIGGER (manual). auto and once opt in.
trigger: auto
drafts: false
language: en
summary: false
post_informational: false
min_confidence: 0.5
min_inline_priority: 2
p2_inline_min_confidence: 0.7
max_inline: 10
ignore_defaults: true
ignore:
  - "vendor/**"
---

# Review rules

- Flag missing error handling on payment and auth paths.
- This service assumes `user` is non-null after `loadUser()`.
- Ignore formatting and naming.
```

| Key | Default | Meaning |
| --- | --- | --- |
| `trigger` | `manual` | `auto` reviews when a pull request is opened, reopened, synchronized, or marked ready for review. `once` reviews the first time only: on `opened`, or on `ready_for_review` when the pull request started as a draft. Later pushes are ignored. `manual` reviews only when someone with write access comments `/dureview`. Omit the key, or omit the file, to use `DUREVIEW_DEFAULT_TRIGGER` (`manual` unless the server sets `auto` or `once`). |
| `drafts` | `false` | When `false`, draft pull requests are skipped until they are marked ready for review. `trigger: manual` still waits for `/dureview`. When `true`, drafts are reviewed like any other pull request. |
| `profile` | `default` | `quiet` inlines P0–P1 only. `default` also inlines P2 when confidence is at least `p2_inline_min_confidence`. `loud` uses the same priorities and lowers that P2 bar to `min_confidence`. |
| `language` | `en` | `en` or `zh`. The model writes finding titles and bodies in this language. Labels, verdict words, and fixed notes use it too. |
| `summary` | `false` | When `true`, also post and update one summary comment, and keep non-inline findings there. When `false`, post one inline comment per finding and nothing else. |
| `post_informational` | `false` | When `true`, informational flags may be posted. They still do not request changes. When `false`, they stay in the database and are left off GitHub. |
| `min_confidence` | `0.5` | Drop findings below this. `0.5` is kept. |
| `min_inline_priority` | `1` for quiet, `2` otherwise | Highest priority number that may be inline. `0` is P0 only, `1` is P0–P1, `2` is P0–P2, `3` also allows P3. `investigate` is never inline. When `summary` is false, findings that are not inline are not posted. |
| `p2_inline_min_confidence` | `0.7`, or `0.5` when the profile is `loud` | P2 confidence required for an inline comment. |
| `max_inline` | `10` | New inline comments per run. Integer from 0 to 100. Extra findings stay in the summary when `summary` is true, and are left unposted when it is false. |
| `ignore` | none | Globs added to the built-in skip list. A pattern with no `/` matches in any directory. |
| `ignore_defaults` | `true` | When `false`, only `ignore` is used. |

A file with no front matter is prompt text only. It uses the default profile, English, no summary comment, and the server's default trigger (`manual` unless `DUREVIEW_DEFAULT_TRIGGER` is set). Unknown keys and duplicate keys fail the review. The front matter is not sent to the model. Keep the prose short.

Built-in skip globs cover lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `composer.lock`, `go.sum`, and the other common lockfile names), generated output (`dist/**`, `build/**`, `coverage/**`, `*.min.js`, `*.min.css`, `*.generated.*`, `*_generated.*`, `*.pb.go`, `*.pb.ts`), and binary assets (images, fonts, archives, and compiled objects). Nested paths match, so `packages/app/package-lock.json` is skipped too.

## Review page

`GET /` and `GET /ui` serve the review list from the webhook process, on the same port. `GET /ui/reviews/<task id>` opens one review. Nothing else listens. The pages are off unless `DUREVIEW_UI_TOKEN` is set to a long random string. With that variable unset, these paths return the same `404` as any other unknown path. `GET /health` and `POST /webhook` do not look at this token, and webhook signature checks are unchanged.

A browser that opens the page without a credential sees a login form. Submitting the token sets an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. `curl` can still send the same value as a bearer token or as the HTTP Basic password (the username is ignored):

```bash
curl -u dureview:"$DUREVIEW_UI_TOKEN" http://127.0.0.1:8787/
curl -H "Authorization: Bearer $DUREVIEW_UI_TOKEN" http://127.0.0.1:8787/ui
```

A request that presents a wrong `Authorization` header is `401` with `WWW-Authenticate`. A browser visit with no `Authorization` header is the login page and does not send `WWW-Authenticate`, so the browser shows the form instead of its own dialog. The token is not accepted from the query string.

The review list is one row per review: repository and pull request number, title, trigger (`auto` for a pull request event, `/dureview` for a comment), a result badge, P0–P3 counts, duration, and time. Green is a pass, yellow is suggestions, red is at least one P0 or P1, and gray is an error. Times are rendered in the browser's local timezone; hovering a time shows the full timestamp. A review that is still running shows 进行中, or 疑似卡住 once it has been running for 30 minutes, instead of a duration that keeps growing. The page can filter by repository, result, and time, and it can search the title, repository, and pull request number. The sidebar footer shows the version, uptime, model, thinking level, whether `auth.json` has a Codex login and when that access token expires, and whether a GitHub App or `GITHUB_TOKEN` is configured. Those last two are yes or no. A finished review also shows the model and thinking level that run actually used, under the title. The sidebar links to the overview and to [Settings](#settings).

Opening a row shows three columns: the pull request's changed files, the diff with saved comments on the lines they refer to, and a summary plus the `.dureview.md` settings used for that run (`trigger`, drafts, profile, and the rest). The model and thinking level that run used are in that settings list. A finished review's summary lists P0–P3 counts. A failed review shows the error recorded for that run, and a review that is still running shows 进行中 or 疑似卡住, without a row of zero counts. A finished review stores the pull request file list, including patches, at the head SHA from that run, and a later view reuses that snapshot. A review that is still running loads the current files from the GitHub API, because the pull request can still move. The API is called with the App installation token, or with the PAT when the server is not using an App. Comments keep the path and line range from the model output. A comment whose line is not in the current diff is listed on that file without a line highlight.

Metadata, posted comments, every finding, model usage, the failure reason, and the file list of a finished review are stored in `$DUREVIEW_DATA_DIR/reviews.sqlite` (mode `0600`). An archive created before a later column gains that column on the next open. Usage columns and the `findings` table are added that way; old rows are not backfilled. `$DUREVIEW_DATA_DIR/reviews.json` is still the short log of the last 50 reviews and does not contain finding text, token counts, or the failure reason. The pages do not include the webhook secret, GitHub tokens, the App private key, or the contents of `auth.json`. An expired access token is not a missing login. pi-ai refreshes it on the next review and writes the new token back to `auth.json`.

## Statistics

`GET /ui` is the overview and uses the same token as the review list. `GET /ui/stats` redirects to it. The page is a row of counts (reviews, average and p95 duration, findings, average tokens, estimated cost), a daily token chart split by model, bar charts for priority, type, category, verdict, and failure reasons, then tables for the most expensive pull requests, the busiest repositories, and the pull requests with the most findings. Type counts are bug, flag, and security. A finding stored before that column existed is unknown. Filters are the last 24 hours, 7 days (the default), 30 days, or all time, plus one repository. Aggregates run in SQL.

Day buckets follow the browser's timezone. The page reloads with a `tz` offset in minutes so `strftime` groups by local calendar days. Times elsewhere on the review pages stay in local time as well. A review with no recorded usage is left out of token averages and the trend. It is not counted as zero. A provider that reports zero tokens or a zero cost is stored as zero. The daily series is the `model` column. A stored thinking level stays on the review and does not split or rename that series.

Usage is one set of columns on `reviews`, filled from the pi-ai ledger for that conversation (assistant generations only; tool-result usage is not added again):

| Column | Meaning |
| --- | --- |
| `input_tokens` | Prompt tokens. Null when usage was not captured. |
| `output_tokens` | Completion tokens, which already include reasoning tokens. |
| `cache_read_tokens` | Cached input tokens. Null when the provider did not report them. |
| `reasoning_tokens` | Reasoning tokens, a subset of `output_tokens`. Null when the provider omitted them. A reported zero is stored as zero. |
| `model_calls` | Assistant generations in the review. |
| `cost_usd` | `usage.cost.total` from pi-ai's catalog rates. This is an estimate, not a ChatGPT subscription invoice. Null when no cost was reported. |

A run that fails after the model has answered still stores those numbers. A failure during checkout, before any conversation exists, stores the model id and leaves the usage columns null.

## Findings table

The `comments` table is still the comments drawn on the diff page, and only for a completed review. It stores `finding_type` and `subtype` too, so the detail page can show the type next to the priority. Those columns are null on comments written before types existed. The `findings` table is a separate row for every finding the model returned, including ones that were not posted inline: `investigate`, P3, low confidence, out of range, ignored paths, overflow past `max_inline`, and fingerprints already on the pull request. There is no clustering UI. The table is there so findings can be grouped later.

| Column | Meaning |
| --- | --- |
| `task_id` | Review run. Foreign key to `reviews`, deleted with that review. |
| `owner`, `repo`, `number` | Repository and pull request number. |
| `sha` | Head SHA reviewed. |
| `title`, `body` | Finding text. |
| `trigger_text` | The trigger the model cited. |
| `priority`, `kind`, `category` | P0–P3, `bug` / `security` / `investigate`, and the finding category. An empty category is stored as `unknown`. |
| `finding_type`, `subtype` | `bug` (`severe`, `non_severe`), `flag` (`investigate`, `informational`), or `security` (`critical`, `warning`). Null on rows written before the column existed. `category` is unchanged. |
| `cwe`, `rule_ref` | Optional identifiers from the model. |
| `confidence` | Model confidence, 0–1. |
| `path`, `start_line`, `end_line` | File and line range. |
| `extension`, `language` | File extension and a coarse language name derived from it (`ts` → `typescript`). Null when the path has no recognized extension. |
| `fingerprint` | Same 12-hex fingerprint used to dedupe comments. |
| `posted` | `1` when the finding was written to GitHub (a new inline comment, or a mention in the summary when `summary` is true). `0` when it was not written. Null when that run did not classify posting. |
| `skip_reason` | Why it was not a new inline comment. Null when it was posted inline. A summary mention keeps the skip reason and sets `posted` to 1. |
| `created_at` | When the review finished, ISO-8601. |

`skip_reason` is one of `low_confidence`, `ignored`, `out_of_range`, `investigate`, `empty_trigger`, `priority`, `p2_confidence`, `overflow`, `already_inlined`, `publish_failed`, or `informational`. `informational` means the flag was stored and not posted because `post_informational` is false. `publish_failed` means the run reached posting and GitHub was not written, so a finding that would have been posted is stored with `posted` 0. A resume that finds this task's own inline comment still stores `posted` 1. A comment left by an earlier task stays `already_inlined`.

Indexes: `findings_task` (`task_id`), `findings_repo` (`owner`, `repo`, `number`), `findings_category` (`category`, `priority`), `findings_fingerprint` (`fingerprint`), `findings_created` (`created_at`), `findings_language` (`language`), `findings_path` (`path`). `reviews_repo_started` covers repository and time filters on the review rows.

## Settings

`GET /ui/settings` is on the same port as the review list, and it uses the same `DUREVIEW_UI_TOKEN`. With that variable unset, the path is `404`. A browser without the cookie sees the login form and returns to `/ui/settings` after a successful login.

The page edits five server values. Each one shows the effective value and where it came from: a saved override, the environment variable, or the built-in default. The unified or split diff view is a separate control on this page: it is saved in the browser and is not one of the five server values. Precedence is **UI override, then environment variable, then built-in default**. Reset clears the override, so the environment variable applies again, or the built-in default when the variable is unset. Saving a value that already matches that fallback does not store an override.

| Setting | Environment variable | Built-in default |
| --- | --- | --- |
| Model | `DUREVIEW_MODEL` | `gpt-5.5` |
| Thinking | `DUREVIEW_THINKING` | `medium` |
| Default trigger | `DUREVIEW_DEFAULT_TRIGGER` | `manual` |
| Skip drafts | `DUREVIEW_SKIP_DRAFTS` | off |
| Checkout TTL (days) | `DUREVIEW_CHECKOUT_TTL_DAYS` | `30` |

The model dropdown is the pi-ai catalog for the provider the process already selected (`openai-codex` or `openai`). The thinking dropdown is `getSupportedThinkingLevels` for the selected model, so `gpt-5.5` does not offer `max` and `gpt-5.6-sol` does. The server rejects an unknown model and a thinking level that model does not support (`clampThinkingLevel` must leave the level unchanged). Provider, host, port, the data directory, and every secret stay out of the page: webhook secret, UI token, `OPENAI_API_KEY`, GitHub token, App id, and private key are not shown and cannot be edited.

Overrides are rows in `$DUREVIEW_DATA_DIR/reviews.sqlite` (`settings`, plus `settings_audit` for who changed what and when). Opening an older database adds the usage columns, then a `thinking` column on `reviews`, then those two settings tables. A change applies to the next review without a restart. A review that has already started keeps the model and thinking captured on its checkpoint, including across a resume. The archive stores that pair together with usage and findings, and the review page and the list show the model and thinking.

The checkout TTL is read on the next sweep (startup, then every six hours). The default trigger and draft skip are read when the next webhook arrives.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DUREVIEW_DATA_DIR` | `./data` | Session database, review archive, `auth.json`, and checkouts. Mount this. |
| `DUREVIEW_HOST` | `0.0.0.0` | Bind address for `npm run dev`. Production uses this only when `HOST` is unset. |
| `DUREVIEW_PORT` | `8787` | Port for `npm run dev`. Production uses this only when `PORT` is unset. |
| `DUREVIEW_WEBHOOK_SECRET` | | HMAC secret for `X-Hub-Signature-256`. Also accepts `GITHUB_WEBHOOK_SECRET`. |
| `DUREVIEW_PROVIDER` | `openai-codex` if a Codex credential exists, otherwise `openai` when `OPENAI_API_KEY` is set | `openai-codex` or `openai` |
| `DUREVIEW_MODEL` | `gpt-5.5` | Model id from the pi-ai catalog for the selected provider. The settings page can override this. |
| `DUREVIEW_THINKING` | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Only levels the model supports are accepted. The settings page can override this. |
| `DUREVIEW_LOGIN_METHOD` | prompt | `device_code` or `browser` |
| `DUREVIEW_SKIP_DRAFTS` | off | `1` skips draft pull requests even when `.dureview.md` sets `drafts: true`. The settings page can override this. |
| `DUREVIEW_DEFAULT_TRIGGER` | `manual` | Trigger used when the base branch has no `.dureview.md` or the file does not set `trigger`. `auto`, `once`, or `manual`. An explicit `trigger` in the file wins. The settings page can override this. |
| `OPENAI_API_KEY` | | Used when the provider is `openai` and no stored key overrides it |
| `GITHUB_APP_ID` | | GitHub App id |
| `GITHUB_APP_PRIVATE_KEY` | | PEM contents, or a path to a PEM |
| `GITHUB_APP_PRIVATE_KEY_PATH` | | Path to the App private key |
| `GITHUB_TOKEN` | | PAT used when App id is unset |
| `GITHUB_API_URL` | `https://api.github.com` | API root for GitHub Enterprise |
| `DUREVIEW_UI_TOKEN` | | Enables the review pages at `GET /`, `GET /ui`, `GET /ui/reviews`, `GET /ui/reviews/<id>`, and `GET /ui/settings`. `GET /ui/stats` redirects to `GET /ui`. Login-form token, Basic-auth password, or bearer token. Unset leaves the pages disabled. |
| `DUREVIEW_CHECKOUT_TTL_DAYS` | `30` | Delete `checkouts/<owner>/<repo>/<sha>` directories older than this many days. `0` deletes every checkout no review is still running. The sweep runs at startup and every six hours, and it skips a directory whose review is still running. The settings page can override this; the next sweep uses the new value. |

`auth.json`, `session.sqlite`, `reviews.sqlite`, and `reviews.json` live in the data directory. Checkouts live in `checkouts/<owner>/<repo>/<sha>`. The pull request head is `HEAD`. The base commit is `refs/dureview/base`, so either side can be read with `git show <sha>:<path>`.

## Development

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run e2e
npm run build
```

Tests use pi-ai's faux model and an in-memory GitHub client. They cover webhook signatures, SHA dedupe, `/dureview` commands, trigger and draft rules, the manual default when `.dureview.md` is missing or omits `trigger`, `DUREVIEW_DEFAULT_TRIGGER`, base-branch config, idempotent posting, a crash between generation and posting, a crash after GitHub accepted the write, a webhook-to-comment pass over `test/fixtures/repo`, schema validation, confidence and path filtering, fingerprint dedupe and fixed marking, comment rendering in English and Chinese, summary-off posting, the Request changes fallback, inline-marker dedupe, review-thread resolution, review-page authentication, the settings page (override over environment over default, rejected models and thinking levels, a change picked up by the next review, and a running review keeping the model and thinking it started with), the statistics page, usage capture (including a failed run), the findings table (including findings that were not posted), SQL aggregation for the statistics page (the model series stays the model id when thinking is stored), the review archive and its filters, the React review detail page, full-file expansion from the checkout, checkout retention, diff comments placed on the live pull request files, the recent-review log, and check runs (success, blocking failure, suggestions, a failed review, a 403 from the Checks API, reuse after a crash during checkout, a retried check update, an abort during create, `filter=all`, and overlapping reviews on one SHA).

Live Codex OAuth and a real GitHub App are not exercised here. Pi Durable is experimental and its API can change between releases. This repo pins `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` at 1.1.0.

## License

MIT. See [LICENSE](LICENSE).
