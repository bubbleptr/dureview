# Reference

Behavior behind the [README](../README.md): what a review posts, how the check run finishes, where history is stored, and what the web UI shows.

## Review task

Each review is one Pi Durable task:

1. **prepare** checks out the head, loads the diff and `.dureview.md` from the base branch, and opens the `dureview` check run on the head SHA.
2. **review** talks to the model with `read`, `grep`, and `submit_review`. No write, edit, or shell tool is offered.
3. **post** publishes to GitHub and completes the check run.

`read` and `grep` are marked `replay: "safe"`. Comment posting is not replay-safe. The post phase reads what is already on the pull request before it writes.

The checkout is `$DUREVIEW_DATA_DIR/checkouts/<owner>/<repo>/<sha>`. The pull request head is `HEAD`. The base commit is `refs/dureview/base`.

`submit_review` returns one JSON document:

- `verdict`: `block`, `fix_recommended`, or `clean`, plus `verdict_reason`, an optional `overall_confidence` from 0 to 1, and up to six `checked` risk areas.
- `findings`: title, `priority` 0–3, `type` and `subtype`, `kind` (`bug`, `security`, or `investigate`), `category` (`correctness`, `security`, `data_integrity`, `concurrency`, `error_handling`, `performance`, `api_contract`, `test_gap`), `path`, `start_line`, `end_line`, `body`, `trigger`, `confidence`, and an optional `suggestion`. `evidence` lists `path:line` locations. `cwe` is an optional id such as `CWE-89`. `rule_ref` is optional.

A payload that omits or garbles `type` or `subtype` is kept. The server fills them from `kind` and priority. The server computes `fingerprint` as the first 12 hex characters of SHA-256 over the path, category, and normalized title. At most 30 findings are stored from one model call. Inline posting is capped separately by `max_inline`.

## What gets posted

Before anything is posted, the server drops findings below `min_confidence`, skips ignored paths, and refuses paths outside the repository. These are not new inline comments:

- `investigate` findings, and bug or security findings with an empty trigger
- informational flags, unless `post_informational` is true
- P3, and P2 under `p2_inline_min_confidence`
- a line range that does not overlap the diff
- findings past `max_inline` (highest priority is kept)

Informational flags never make the review event `REQUEST_CHANGES`.

### `summary: false` (default)

One inline comment per posted finding, on `side: RIGHT`, in one pull request review. The review body is empty. A multi-line finding sets `start_line`. A GitHub suggestion block is included only when the suggestion replaces that exact diff range. The event is `REQUEST_CHANGES` when any posted comment is P0 or P1 and is not an informational flag, and `COMMENT` otherwise. GitHub rejects Request changes when the token's user opened the pull request; dureview logs that and submits Comment instead.

When this run posts no inline comments, and no earlier dureview inline comment is still open, dureview submits one pull request review with event `COMMENT`. The body is plain text: `dureview review complete: no issues to address (head abc1234)` in English, or `dureview 审查完成：未发现需要处理的问题（head abc1234）` when `language` is `zh`. `abc1234` is the first seven characters of the head SHA. The body ends with `<!-- dureview:clean task=<task id> sha=<full sha> -->`. The same head SHA is posted at most once. A retry finds the marker already on the pull request, and two overlapping publishes of that head share one in-process lock. The event is Comment. It is not Request changes and not Approve. The body adds a count only for findings the `dureview` check lists as not posted inline (open, not informational: folded priority, lines outside the diff, past `max_inline`). Findings below `min_confidence`, on an ignored path, or withheld as informational are left off both. A later head that has inline findings is posted as usual. A clean note on an older SHA is left in place. The check run still completes. On a later push, an open fingerprint that disappeared is resolved with GitHub's `resolveReviewThread`. If that fails, dureview replies `fixed in <sha>` (or `已在 <sha> 修复` when `language` is `zh`).

### `summary: true`

The summary comment is updated in place. Its heading is the verdict. Non-inline findings (`investigate`, missing triggers, P3, low-confidence P2, out-of-range lines) go in collapsed sections. Findings from the previous push that are gone are listed as fixed. The inline review uses `event: COMMENT`, and its body records the fingerprints that were posted so a later push does not comment on them again.

### Which events start a review

`.dureview.md` comes from the base branch. When it is missing, or it does not set `trigger`, the trigger is `DUREVIEW_DEFAULT_TRIGGER` (`manual` unless the server sets `auto` or `once`).

| Trigger | Pull request events |
| --- | --- |
| `manual` | None. `/dureview` only. |
| `auto` | `opened`, `reopened`, `synchronize`, `ready_for_review`. A new head SHA is a new review. The same `owner/repo#number@sha` is not reviewed twice. |
| `once` | The first allowed `opened` or `ready_for_review`. Later pushes and a reopen do not start another automatic review. A draft skipped at open can take that one review on `ready_for_review`. |

`drafts: false` skips drafts. `DUREVIEW_SKIP_DRAFTS=1` (or `true`) skips drafts even when the file sets `drafts: true`.

`/dureview` always reviews the current head, including drafts and `manual` repositories. The same comment does not start two reviews of that head SHA. A new `/dureview` comment does, even when that SHA was already reviewed. The command also claims the `trigger: once` slot when that slot is still open. The command still runs after the automatic review. `ping` and other events are acknowledged and ignored.

A failed automatic review can be replaced by a later delivery. A running or completed review of that SHA is kept.

## Check runs

The check name is `dureview`. Counts include findings past the confidence floor and not on an ignored path, and they exclude informational flags. When `summary` is false, findings that were not posted inline are listed in the check summary, so a failing check is explained on the commit even when the conversation has no comment.

A second review of the same commit completes any other in-progress `dureview` run on that SHA with conclusion `neutral` and title "Superseded" (已被后续审查取代 when `language` is `zh`). A transient Checks API error is retried. A 403 is a missing permission: dureview logs it and continues, and does not remember that skip across a crash that happened before the check id was saved. If creating the check succeeded and the process stopped before the id was saved, the next attempt finds that run by its task id.

## Resume markers

Hidden HTML comments let a resume see a write GitHub already accepted:

```html
<!-- dureview:summary owner/repo#42 -->
<!-- dureview:task 17 -->
<!-- dureview:inline 17 -->
<!-- dureview:finding a1b2c3d4e5f6 17 -->
<!-- dureview:fixed a1b2c3d4e5f6 <sha> -->
<!-- dureview:clean task=17 sha=<full sha> -->
<!-- dureview:ledger <hex> -->
<!-- dureview:fps a1b2c3d4e5f6,b2c3d4e5f6a1 -->
```

The summary, task, inline, ledger, and `fps` markers are used when `summary: true`. The finding marker is embedded in each inline comment when `summary: false`. The fixed marker is embedded in a reply when a thread could not be resolved. The clean marker is on the Comment review posted when `summary: false` and this run inlines nothing. A later publish of that same head SHA sees it and does not post another. Summary-mode inline comments also carry a visible `<sub>dureview · fp:…` footer. The summary marker is per pull request, so the next push updates that comment.

## Data files

All of these live under `DUREVIEW_DATA_DIR`.

| File | What it holds |
| --- | --- |
| `auth.json` | Codex credential. Mode `0600`. |
| `session.sqlite` | Pi Durable session. |
| `reviews.sqlite` | Review archive. Mode `0600`. A completed or failed review also stores its file list, including patches, in `pull_snapshots`. |
| `reviews.json` | The last 50 reviews. No finding text, token counts, or failure reason. Mode `0600`. |
| `checkouts/<owner>/<repo>/<sha>-<taskId>` | One working tree per review task. Removed when that task ends, including abort. The sweep removes trees whose task is not running once they are older than one hour (or the checkout TTL, if shorter) and trims the oldest of those when the directory exceeds `DUREVIEW_CHECKOUT_MAX_BYTES`. |

The web UI does not show the webhook secret, GitHub tokens, the App private key, or the contents of `auth.json`. An expired access token is still a login. pi-ai refreshes it on the next review.

Opening an older `reviews.sqlite` adds columns and tables on the next open. Old rows are not backfilled. Settings overrides are rows in `settings`, with `settings_audit` for who changed what and when.

### Usage columns

Filled from the pi-ai ledger for that conversation (assistant generations only; tool-result usage is not added again). A run that fails after the model has answered still stores them. A failure during checkout stores the model id and leaves the usage columns null. A review with no recorded usage is left out of token averages. A reported zero is stored as zero.

| Column | Meaning |
| --- | --- |
| `input_tokens` | Prompt tokens. Null when usage was not captured. |
| `output_tokens` | Completion tokens, which already include reasoning tokens. |
| `cache_read_tokens` | Cached input tokens. Null when the provider did not report them. |
| `reasoning_tokens` | Reasoning tokens, a subset of `output_tokens`. Null when omitted. |
| `model_calls` | Assistant generations in the review. |
| `cost_usd` | `usage.cost.total` from pi-ai's catalog rates. An estimate, not a ChatGPT subscription invoice. Null when no cost was reported. |

The overview's daily series is the `model` column. A stored thinking level stays on the review and does not split that series.

### Findings

`comments` is what the detail page draws, for a completed review. `findings` is every finding the model returned, including ones that were not posted. `posted` is `1` when the finding was written to GitHub (a new inline comment, or a mention in the summary when `summary` is true) and `0` when it was not. Null means that run did not classify posting. `skip_reason` is why it was not a new inline comment. A summary mention keeps the skip reason and sets `posted` to 1.

`skip_reason` is one of `low_confidence`, `ignored`, `out_of_range`, `investigate`, `empty_trigger`, `priority`, `p2_confidence`, `overflow`, `already_inlined`, `publish_failed`, or `informational`.

`finding_type` and `subtype` are null on rows written before those columns existed. `kind` remains `bug`, `security`, or `investigate`. An empty category is stored as `unknown`. `extension` and `language` come from the path (`ts` → `typescript`) and are null when the extension is not recognized.

Indexes: `reviews_started`, `reviews_repo_started`, `findings_task`, `findings_repo`, `findings_category`, `findings_fingerprint`, `findings_created`, `findings_language`, `findings_path`.

## Web UI

`GET /` and `GET /ui` are the overview. `GET /ui/reviews/<task id>` is one review. A completed or failed review stores the file list at that run's head SHA, including patches, in `pull_snapshots`. A later view reuses that snapshot and does not call GitHub. The pull request files API is the live head, so that list is stored only when the head is still the reviewed SHA after the fetch. When the head has moved, the stored list is the compare of the review's base and head (`baseSha...sha`). A running review always loads the current files from the GitHub API and is not written into the snapshot, because the pull request can still move. The API is called with the App installation token, or with the personal access token when the server is not using an App. A failed fetch, including the detail page's 20 second deadline, is not stored. The saved comments still render, and a comment whose line is not in the loaded diff is listed on that file without a line highlight. A later GitHub error after a successful snapshot serves the snapshot. A write failure is logged and does not fail the page.

The file list is `@pierre/trees` and the diff is `@pierre/diffs`. Highlighting runs in the browser for an expanded file within 480px of the viewport. The highlighted HTML is not stored. Files with no comments start collapsed. A file with comments shows ten lines of context above and below each comment. The file header collapses or expands the whole file. Unified or split is chosen on the settings page and saved in the browser.

The review list is one row per review: repository and pull request number, title, trigger (`auto` for a pull request event, `/dureview` for a comment), a result badge, P0–P3 counts, duration, and time. Green is a pass, yellow is suggestions, red is at least one P0 or P1, and gray is an error. Times use the browser's timezone. A review that is still running shows 进行中, or 疑似卡住 after 30 minutes. A finished review shows the model and thinking level that run used.

The overview is counts (reviews, average and p95 duration, findings, average tokens, estimated cost), a daily token chart split by model, bar charts for priority, type, category, verdict, and failure reasons, then tables for the most expensive pull requests, the busiest repositories, and the pull requests with the most findings. Day buckets follow the browser's timezone via a `tz` offset in minutes. Aggregates run in SQL.

The sidebar links to the overview, the review list, and settings. Its footer is the theme control. The settings page shows the version, uptime, provider and model, thinking level, whether `auth.json` has a Codex login and when that access token expires, and yes or no for GitHub App and GitHub token.

The provider control lists ChatGPT (`openai-codex`), GitHub Copilot, xAI, OpenAI, OpenRouter, and DeepSeek when that catalog has a usable model. The model control is a search field over the pi-ai catalog for the selected provider. OpenRouter ids may contain `~` and `/`. The thinking control lists the levels that model supports. `gpt-5.6-sol` includes `max`. The server rejects an unknown model and a thinking level outside that list. The default trigger and draft skip are read when the next webhook arrives. The checkout TTL is read on the next sweep.

Subscription login on that page is a device code for ChatGPT (the Codex path), GitHub Copilot, and xAI. The page shows the verification URL and the code, then polls until the provider finishes. API keys are OpenAI, OpenRouter, and DeepSeek. A saved key overrides the environment variable. After a save, the page shows the last four characters and does not return the full key. The GitHub App button uses GitHub's manifest flow. Environment credentials still win: an env app over a saved app, `GITHUB_TOKEN` over a saved app when the env app is unset, and `DUREVIEW_WEBHOOK_SECRET` or `GITHUB_WEBHOOK_SECRET` over the secret stored with the app.

## Ignore globs

With `ignore_defaults: true` (the default), these globs apply in addition to `ignore`. Nested paths match, so `packages/app/package-lock.json` is skipped.

```text
**/package-lock.json
**/yarn.lock
**/pnpm-lock.yaml
**/bun.lock
**/bun.lockb
**/npm-shrinkwrap.json
**/Cargo.lock
**/Gemfile.lock
**/poetry.lock
**/composer.lock
**/go.sum
**/Pipfile.lock
**/packages.lock.json
**/gradle.lockfile
**/pubspec.lock
**/dist/**
**/build/**
**/coverage/**
**/*.min.js
**/*.min.css
**/*.generated.*
**/*_generated.*
**/*.pb.go
**/*.pb.ts
**/*_pb2.py
**/*.d.ts.map
**/*.js.map
**/*.css.map
**/*.png
**/*.jpg
**/*.jpeg
**/*.gif
**/*.webp
**/*.ico
**/*.pdf
**/*.woff
**/*.woff2
**/*.ttf
**/*.eot
**/*.zip
**/*.gz
**/*.tgz
**/*.tar
**/*.wasm
**/*.class
**/*.o
**/*.so
**/*.dll
**/*.exe
**/*.pyc
**/*.bin
```
