<p align="center"><img src="docs/assets/dureview-logo.png" alt="dureview" width="128"></p>

# dureview

Self-hosted pull request review bot. Comment `/dureview` on a pull request and it posts P0–P3 inline findings plus a check run named `dureview`.

dureview is one long-running process on [Pi Durable](https://github.com/earendil-works/pi) (`@earendil-works/pi-durable`). It keeps a ChatGPT subscription credential and a SQLite review history on a persistent volume, and a crash resumes the review. On Fly, run one machine and mount that volume at `/data`.

> **ChatGPT subscription use is at your own risk.** The Codex login signs in with a ChatGPT Plus/Pro subscription (the same login pi-ai uses). OpenAI's terms may restrict automated use of subscription accounts. You are responsible for complying with those terms. With an API key, set `DUREVIEW_PROVIDER=openai` and `OPENAI_API_KEY` instead.

## Usage

On a pull request, a comment whose first line is `/dureview` reviews the current head, including drafts. Leading and trailing whitespace on that line is ignored.

```text
/dureview
```

The author needs write, maintain, or admin permission. dureview reacts with 👀 and ignores the command from its own GitHub App (`{slug}[bot]`, from `GET /app`) or from the personal access token user (`GET /user`). Anyone else is ignored, with no reaction.

Each posted finding is an inline comment. The label is the priority, the type, and a confidence band, for example `**P2 · Bug · Non-severe** · confidence high` or `P0 · Security · Critical · CWE-89`.

| Type | Subtypes |
| --- | --- |
| `bug` | `severe`, `non_severe` |
| `flag` | `investigate`, `informational` |
| `security` | `critical`, `warning` |

Priority is P0–P3 and is separate from type. The default prompt looks for bugs, security issues, edge cases, broken assumptions, and missing error handling. It does not comment on style.

The same head commit gets a check run named `dureview`. It stays in progress while the review runs, then completes:

| Outcome | Conclusion | Title (`language: en`) |
| --- | --- | --- |
| Nothing it stands behind | success | No findings |
| Any P0 or P1 | failure | Blocking findings |
| Only P2 and P3 | success | N suggestions (`1 suggestion` when there is one) |
| The review errors | failure | Review failed |
| A bad `.dureview.md` or an unknown model | action required | Action required |
| The task is aborted | cancelled | Review cancelled |

With `language: zh` those titles are 未发现问题, 有阻断性问题, 有 N 条建议, 审查失败, 需要处理, and 审查已取消. An `action_required` check links to [`.dureview.md`](#dureviewmd). Informational flags are left out of the counts. In branch protection, require the status check `dureview`.

Installing the GitHub App does not start reviews. The built-in trigger is `manual` (this comment only). Opt in with `trigger: auto` or `trigger: once` in [`.dureview.md`](#dureviewmd) on the pull request's base branch, or with `DUREVIEW_DEFAULT_TRIGGER`. By default there is no summary comment (`summary: false`): one inline comment per posted finding. When this run posts nothing inline, and no earlier dureview inline comment is still open, dureview submits one Comment review: `dureview review complete: no issues to address (head abc1234)`, or `dureview 审查完成：未发现需要处理的问题（head abc1234）` when `language` is `zh`. It does not request changes or approve. The same head SHA gets that note once. If findings were held back, the note includes the count and points at the `dureview` check.

A P0 or P1 inline finding submits **Request changes**, except an informational flag. Anything else uses **Comment**. dureview does not approve. How findings are filtered, deduped, and updated on the next push is in [What gets posted](docs/reference.md#what-gets-posted).

## Install

Requires Node.js 22.19 or newer, git, and a GitHub App or a personal access token. The default model is `gpt-5.5`.

### Docker

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

`dureview serve` starts without a webhook secret or GitHub credential, so `/ui/settings` can finish that setup. A half-set App id or private key still refuses to start. Webhook deliveries fail until a secret exists.

To use an API key, skip `login` and pass the provider. A key saved on the settings page overrides the environment variable and is stored in the data directory.

```bash
docker run --rm -p 8787:8787 -v dureview-data:/data \
  -e DUREVIEW_PROVIDER=openai \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e DUREVIEW_WEBHOOK_SECRET="$DUREVIEW_WEBHOOK_SECRET" \
  -e GITHUB_TOKEN="$GITHUB_TOKEN" \
  dureview serve
```

`GET /health` returns `{"ok":true}`. Point the GitHub webhook at `POST /webhook`.

### Compose

See [`.env.example`](.env.example). The Compose file forwards the variables listed in [`docker-compose.yml`](docker-compose.yml). Its default provider is `openai-codex`; set `DUREVIEW_PROVIDER=openai` when you use an API key.

```bash
docker compose run --rm -it dureview login
docker compose up -d
```

### Node

`npm run dev` is the Vite dev server. Production is still one Node process: `npm start` is `node dist/cli.js serve`, which loads the built TanStack Start server (`.output/server/index.mjs`) in-process.

```bash
npm ci

DUREVIEW_DATA_DIR=./data \
DUREVIEW_WEBHOOK_SECRET=replace-with-a-long-random-string \
GITHUB_TOKEN=github_pat_... \
DUREVIEW_UI_TOKEN=replace-with-a-long-random-string \
npm run dev
```

```bash
npm run build
DUREVIEW_DATA_DIR=./data \
DUREVIEW_WEBHOOK_SECRET=replace-with-a-long-random-string \
GITHUB_TOKEN=github_pat_... \
DUREVIEW_UI_TOKEN=replace-with-a-long-random-string \
npm start
```

`DUREVIEW_HOST` defaults to `0.0.0.0` and `DUREVIEW_PORT` defaults to `8787`. The dev server follows those two variables. When `PORT` or `HOST` is already set (Fly sets `PORT`), the production process keeps them.

Codex login outside Docker:

```bash
DUREVIEW_DATA_DIR=./data node dist/cli.js login
```

`dureview login` stores the Codex credential in `$DUREVIEW_DATA_DIR/auth.json` (mode `0600`). Browser login uses a localhost callback. Device-code login prints a URL and a code; set `DUREVIEW_LOGIN_METHOD=device_code` to skip the prompt, which is what a non-TTY session does. `dureview logout` deletes the credential. The settings page can also sign in with a device code for ChatGPT, GitHub Copilot, and xAI, because a hosted server cannot receive a localhost callback. pi-ai refreshes an expired access token and writes the new token back to `auth.json`, so the data directory has to survive restarts. Do not bake `auth.json` into the image.

### Fly

Run one machine. Mount a volume at `/data` and set `DUREVIEW_DATA_DIR=/data`. Review history is `$DUREVIEW_DATA_DIR/reviews.sqlite` on that volume. Pi Durable storage is not locked across processes, so do not run a second listener beside this one.

### GitHub App

1. Create a GitHub App owned by the account that should review pull requests. `/ui/settings` can create it with the permissions and webhook below, and stores the app id, private key, and webhook secret in the data directory. An env app still wins over that file, and `GITHUB_TOKEN` wins over a saved app when the env app is unset.
2. Permissions: **Contents** (read), **Pull requests** (read and write), **Issues** (read and write), **Checks** (read and write). Metadata is included.
3. Subscribe to **Pull request** and **Issue comment**.
4. Webhook URL: `https://<your-host>/webhook`. Secret: the same value as `DUREVIEW_WEBHOOK_SECRET`.
5. Install the App on the repositories it should review.
6. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (PEM contents, with newlines as `\n`, or a path). `GITHUB_APP_PRIVATE_KEY_PATH` is a path as well.

The webhook payload includes `installation.id`. dureview mints a short-lived installation token for the API and for `git fetch`. The token is not stored. It checks out `pull/<number>/head` from the repository that hosts the pull request, so fork pull requests work when the App can read that repository.

A personal access token works when the App variables are unset. Set `GITHUB_TOKEN` and leave `GITHUB_APP_ID` unset. The token needs read access to the repository and permission to create issue comments and pull request reviews. A 403 from the Checks API is logged, and the review is still posted.

## `.dureview.md`

Optional file at the repository root. dureview reads it from the pull request's **base branch**, so a pull request cannot change its own trigger, thresholds, or prompt. Those updates apply after it merges. Prose after the front matter is appended to the review prompt. Keys you omit keep the defaults below, except `trigger`, which uses `DUREVIEW_DEFAULT_TRIGGER` (`manual`) when the key is absent. An explicit key wins. A file with no front matter is prompt text only.

```markdown
---
trigger: auto
drafts: false
language: en
summary: false
---

Flag missing error handling on payment and auth paths.
This service assumes `user` is non-null after `loadUser()`.
```

| Key | Default | Meaning |
| --- | --- | --- |
| `trigger` | `manual` | `auto` reviews `opened`, `reopened`, `synchronize`, and `ready_for_review`. `once` reviews the first allowed `opened` or `ready_for_review` only. `manual` reviews only on `/dureview`. |
| `drafts` | `false` | Drafts are skipped until marked ready. `trigger: manual` still waits for `/dureview`. `true` reviews drafts the same way as open pull requests. |
| `profile` | `default` | `quiet` inlines P0–P1. `default` also inlines P2 at `p2_inline_min_confidence`. `loud` uses the same priorities and sets that P2 bar to `0.5`. |
| `language` | `en` | `en` or `zh`. Finding prose, labels, verdicts, fixed notes, and the clean-review note use it. |
| `summary` | `false` | `true` also posts and updates one summary comment. `false` posts inline comments, and one Comment review when this run posts none. |
| `post_informational` | `false` | `true` allows informational flags on GitHub. They still do not request changes. |
| `min_confidence` | `0.5` | Drop findings below this. `0.5` is kept. |
| `min_inline_priority` | `1` for `quiet`, `2` otherwise | `0` is P0 only, `1` is P0–P1, `2` is P0–P2, `3` also allows P3. |
| `p2_inline_min_confidence` | `0.7`, or `0.5` for `loud` | P2 confidence required for an inline comment. |
| `max_inline` | `10` | New inline comments per run, from 0 to 100. |
| `ignore` | none | Extra globs. A pattern with no `/` matches in any directory. At most 50. |
| `ignore_defaults` | `true` | `false` uses only `ignore`. |

Unknown keys and duplicate keys fail the review. The front matter is not sent to the model. Built-in skip globs (lockfiles, generated output, binaries) are listed in [Ignore globs](docs/reference.md#ignore-globs).

## Environment

Settings-page values use this order: a saved UI override, then the environment variable, then the built-in default. Saving a value that already matches the fallback does not store an override. Reset clears the override. A change applies to the next review; a review that has already started keeps the model and thinking on its checkpoint.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DUREVIEW_DATA_DIR` | `./data` | `auth.json`, `github-app.json`, `session.sqlite`, `reviews.sqlite`, `reviews.json`, and `checkouts/`. `auth.json` and `github-app.json` are mode `0600`. Mount this. |
| `DUREVIEW_HOST` | `0.0.0.0` | Bind address for `npm run dev`. Production uses it only when `HOST` is unset. |
| `DUREVIEW_PORT` | `8787` | Port for `npm run dev`. Production uses it only when `PORT` is unset. |
| `DUREVIEW_WEBHOOK_SECRET` | | HMAC secret for `X-Hub-Signature-256`. Also accepts `GITHUB_WEBHOOK_SECRET`. Wins over the secret stored with a GitHub App from the settings page. |
| `DUREVIEW_PROVIDER` | Codex when that credential exists, otherwise `openai` when `OPENAI_API_KEY` is set, otherwise `openai-codex` | `openai-codex`, `github-copilot`, `xai`, `openai`, `openrouter`, or `deepseek`. The settings page can override this. |
| `DUREVIEW_MODEL` | `gpt-5.5` | Model id from the pi-ai catalog for the selected provider. The settings page can override this. |
| `DUREVIEW_THINKING` | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Only levels that model supports are accepted. The settings page can override this. |
| `DUREVIEW_MAX_OUTPUT_TOKENS` | `16000` | Most tokens one model response may use. The settings page can override this. |
| `DUREVIEW_LOGIN_METHOD` | prompt | `device_code` or `browser`. |
| `DUREVIEW_SKIP_DRAFTS` | off | `1` or `true` skips drafts even when `.dureview.md` sets `drafts: true`. The settings page can override this. |
| `DUREVIEW_DEFAULT_TRIGGER` | `manual` | `auto`, `once`, or `manual`, used when the base branch has no `.dureview.md` or the file omits `trigger`. An explicit `trigger` in the file wins. The settings page can override this. |
| `OPENAI_API_KEY` | | OpenAI API key. A key saved on the settings page overrides it. |
| `OPENROUTER_API_KEY` | | OpenRouter API key. A saved key overrides it. |
| `DEEPSEEK_API_KEY` | | DeepSeek API key. A saved key overrides it. |
| `GITHUB_APP_ID` | | GitHub App id. Together with the private key, this wins over an app saved on the settings page. |
| `GITHUB_APP_PRIVATE_KEY` | | PEM contents, or a path to a PEM. |
| `GITHUB_APP_PRIVATE_KEY_PATH` | | Path to the App private key. |
| `GITHUB_TOKEN` | | Personal access token when the env app is unset. Wins over an app saved on the settings page. |
| `GITHUB_API_URL` | `https://api.github.com` | API root for GitHub Enterprise. |
| `DUREVIEW_UI_TOKEN` | | Enables the web UI. Unset leaves those paths at `404`. |
| `DUREVIEW_CHECKOUT_TTL_DAYS` | `30` | Delete `checkouts/<owner>/<repo>/<sha>-<taskId>` older than this many days when that task is not running. Each review has its own checkout and deletes it when the task ends, including abort. The sweep also deletes any such checkout older than one hour, and `0` deletes every checkout with no running task. The sweep runs at startup and every six hours. The settings page can override this. |
| `DUREVIEW_CHECKOUT_MAX_BYTES` | `1073741824` | When `checkouts/` is larger than this, the sweep deletes the oldest checkouts whose tasks are not running. A running task keeps its own directory. |

Host, port, the data directory, and the UI token are not editable on the settings page. Saved API keys and the GitHub App private key are write-only: the page shows that they are configured, and a saved key or webhook secret shows its last four characters.

## Web UI

The UI is off until `DUREVIEW_UI_TOKEN` is set. With it unset, these paths return the same `404` as any other unknown path. `GET /health` and `POST /webhook` do not look at the token.

| Path | Page |
| --- | --- |
| `GET /` and `GET /ui` | Overview: counts, charts, token usage, and findings by type (bug, flag, security). |
| `GET /ui/reviews` | Review list. |
| `GET /ui/reviews/<task id>` | Review detail: changed files, the diff with inline findings, and the summary. |
| `GET /ui/settings` and `POST /ui/settings` | Provider, model, thinking, trigger, draft skip, checkout TTL, device-code login, API keys, and GitHub App setup. |
| `GET /ui/stats` | Redirects to `GET /ui`. |
| `GET /ui/login` and `POST /ui/login` | Login form. |

A browser without a credential sees the login form. The cookie is `dureview_ui`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, 30 days. The value is `DUREVIEW_UI_TOKEN`. The token is also the HTTP Basic password (any username) or a bearer token. A wrong `Authorization` header is `401`. A browser visit with no `Authorization` header is the form and does not send `WWW-Authenticate`. The token is not accepted from the query string.

```bash
curl -u dureview:"$DUREVIEW_UI_TOKEN" http://127.0.0.1:8787/
curl -H "Authorization: Bearer $DUREVIEW_UI_TOKEN" http://127.0.0.1:8787/ui
```

The settings page also chooses a unified or split diff. That choice is stored in the browser. A completed or failed review stores the file list at that run's head SHA, including patches, and a later view reuses the snapshot. A running review loads the current files from GitHub. Overview filters are the last 24 hours, 7 days (the default), 30 days, or all time, plus one repository. The review list can filter by repository, result, and time, and it can search the title, repository, and pull request number. Layout, the diff, and what is stored are in [Web UI](docs/reference.md#web-ui).

## Caveats

Run one process. A second listener on the same data directory is unsafe.

Pi Durable is experimental. This repo pins `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` at 1.1.0.

A Cloudflare Durable Objects deployment is in progress and is not part of this process. See draft pull request [#10](https://github.com/bubbleptr/dureview/pull/10).

Posting rules, check-run edge cases, resume markers, and the SQLite archive are in [docs/reference.md](docs/reference.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
