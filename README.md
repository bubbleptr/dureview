# dureview

dureview is a self-hosted pull request reviewer. It reads a GitHub pull request, checks out that commit, and asks a **different model family** (OpenAI GPT) to look for real bugs. It posts one summary comment and inline comments on the diff.

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

`GET /health` returns `{"ok":true}`. Point a GitHub webhook at `POST /webhook`.

Without Docker:

```bash
npm ci
npm run build
DUREVIEW_DATA_DIR=./data node dist/cli.js login
DUREVIEW_DATA_DIR=./data DUREVIEW_WEBHOOK_SECRET=... GITHUB_TOKEN=... node dist/cli.js serve
```

Run **one process**. Pi Durable storage is not locked across processes.

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
2. Permissions: **Contents** (read), **Pull requests** (read and write), **Issues** (read and write). Metadata is included.
3. Subscribe to the **Pull request** event.
4. Webhook URL: `https://<your-host>/webhook`. Webhook secret: the same value as `DUREVIEW_WEBHOOK_SECRET`.
5. Install the App on the repositories it should review.
6. Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (the PEM, with newlines as `\n`, or a path via `GITHUB_APP_PRIVATE_KEY_PATH`).

The webhook payload includes `installation.id`. dureview mints a short-lived installation token for the API and for `git fetch`. The token is not stored.

dureview checks out `pull/<number>/head` from the repository that hosts the pull request, so fork pull requests work when the App can read that repository.

### Personal access token

Set `GITHUB_TOKEN` and omit the App variables. The token needs read access to the repository and permission to create issue comments and pull request reviews. Do not set `GITHUB_APP_ID` when using a token.

### What gets reviewed

`pull_request` actions `opened`, `synchronize`, and `reopened` enqueue a review of the head SHA. Other events, including `ping`, are acknowledged and ignored. Set `DUREVIEW_SKIP_DRAFTS=1` to skip draft pull requests.

The same `owner/repo#number@sha` is not reviewed twice. A later push (a new SHA) updates the existing summary comment. Inline comments are posted only for findings that were not already commented. A finding that disappears is marked fixed in the summary.

## What the model sees

Each review is one Pi Durable task:

1. **prepare** checks out the head and loads the diff plus an optional `.dureview.md`.
2. **review** runs a conversation with `read`, `grep`, and `submit_review`. No write, edit, or shell tool is offered.
3. **post** publishes to GitHub.

The default prompt is adversarial and disciplined. It looks for real bugs, security issues, edge cases, broken assumptions, and missing error handling, and it may record a suspicion it cannot prove. It does not praise the change or comment on style. Adapted from Codex's open review rubric, a finding has to be introduced by this pull request, name the code it affects, and come with a concrete trigger. Pre-existing bugs, intentional changes, and "this could be nicer" comments are out of scope.

`submit_review` returns one JSON document:

- `verdict`: `block`, `fix_recommended`, or `clean`, plus a short `verdict_reason`, an optional `overall_confidence` from 0 to 1, and up to six `checked` risk areas.
- `findings`: each has a title, `priority` `0`–`3` (P0–P3), `kind` (`bug`, `security`, or `investigate`), `category` (`correctness`, `security`, `data_integrity`, `concurrency`, `error_handling`, `performance`, `api_contract`, `test_gap`), `path`, `start_line`, `end_line`, `body`, `trigger`, `confidence`, and an optional `suggestion` that can replace that line range. `evidence` lists `path:line` locations when another call site is affected. `cwe` and `rule_ref` are optional.

The server computes `fingerprint` as the first 12 hex characters of SHA-256 over the path, category, and normalized title. The model does not choose it. That fingerprint is how a later push recognizes the same finding.

`read` and `grep` are marked `replay: "safe"` (pi-durable 1.0's built-in `read` tool is not). Comment posting is **not** replay-safe. The post phase lists issue comments and reviews first. A hidden marker carries the task id:

```html
<!-- dureview:summary owner/repo#42 -->
<!-- dureview:task 17 -->
<!-- dureview:inline 17 -->
```

If the process dies after GitHub accepted a write, resume sees the marker and does not post a second copy. The summary marker is per pull request, so the next push updates that comment instead of adding another.

Before anything is posted, the server drops findings below the confidence floor, skips lockfiles, generated files, binaries, and `dist/` (plus any globs in `.dureview.md`), and refuses paths outside the repository. `investigate` findings, P3 findings, and P2 findings under the P2 confidence bar go to a collapsed section of the summary. So do bug or security findings with an empty trigger. A line range that does not overlap the diff goes in a collapsed "out of range" section. Everything else can be an inline comment, at most `max_inline` per run, highest priority first. A GitHub suggestion block is included only when the suggestion replaces that exact diff range.

The summary comment is updated in place. Its heading is the verdict (block, fix recommended, or clean). The body lists actionable findings by severity, then the collapsed sections, then what was checked. A clean review with no findings shows that checked list. Findings from the previous push that are gone are listed as fixed.

Inline comments are a pull request review with `event: COMMENT` on `side: RIGHT`. A multi-line finding sets `start_line`. The review body records the fingerprints that were posted, so a later push does not comment on them again.

## `.dureview.md`

Optional file at the repository root. Prose after the optional front matter is appended to the review prompt. The front matter overrides the posting thresholds. Keys you do not set keep the profile's defaults. An explicit key wins over the profile.

```markdown
---
profile: default
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
| `profile` | `default` | `quiet` inlines P0–P1 only. `default` also inlines P2 when confidence is at least `p2_inline_min_confidence`. `loud` uses the same priorities and lowers that P2 bar to `min_confidence`. |
| `min_confidence` | `0.5` | Drop findings below this. `0.5` is kept. |
| `min_inline_priority` | `1` for quiet, `2` otherwise | Highest priority number that may be inline. `0` is P0 only, `1` is P0–P1, `2` is P0–P2, `3` also allows P3. `investigate` is never inline. |
| `p2_inline_min_confidence` | `0.7`, or `0.5` when the profile is `loud` | P2 confidence required for an inline comment. |
| `max_inline` | `10` | New inline comments per run. Integer from 0 to 100. Extra findings stay in the summary. |
| `ignore` | none | Globs added to the built-in skip list. A pattern with no `/` matches in any directory. |
| `ignore_defaults` | `true` | When `false`, only `ignore` is used. |

A file with no front matter is prompt text only and uses the default profile. Unknown keys and duplicate keys fail the review. The front matter is not sent to the model. Keep the prose short.

Built-in skip globs cover lockfiles (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `Cargo.lock`, `Gemfile.lock`, `poetry.lock`, `composer.lock`, `go.sum`, and the other common lockfile names), generated output (`dist/**`, `build/**`, `coverage/**`, `*.min.js`, `*.min.css`, `*.generated.*`, `*_generated.*`, `*.pb.go`, `*.pb.ts`), and binary assets (images, fonts, archives, and compiled objects). Nested paths match, so `packages/app/package-lock.json` is skipped too.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DUREVIEW_DATA_DIR` | `./data` | SQLite session, `auth.json`, and checkouts. Mount this. |
| `DUREVIEW_HOST` | `0.0.0.0` | Webhook bind address |
| `DUREVIEW_PORT` | `8787` | Webhook port |
| `DUREVIEW_WEBHOOK_SECRET` | | HMAC secret for `X-Hub-Signature-256`. Also accepts `GITHUB_WEBHOOK_SECRET`. |
| `DUREVIEW_PROVIDER` | `openai-codex` if a Codex credential exists, otherwise `openai` when `OPENAI_API_KEY` is set | `openai-codex` or `openai` |
| `DUREVIEW_MODEL` | `gpt-5.5` | Model id from the pi-ai catalog for the selected provider |
| `DUREVIEW_THINKING` | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `DUREVIEW_LOGIN_METHOD` | prompt | `device_code` or `browser` |
| `DUREVIEW_SKIP_DRAFTS` | off | `1` skips draft pull requests |
| `OPENAI_API_KEY` | | Used when the provider is `openai` and no stored key overrides it |
| `GITHUB_APP_ID` | | GitHub App id |
| `GITHUB_APP_PRIVATE_KEY` | | PEM contents, or a path to a PEM |
| `GITHUB_APP_PRIVATE_KEY_PATH` | | Path to the App private key |
| `GITHUB_TOKEN` | | PAT used when App id is unset |
| `GITHUB_API_URL` | `https://api.github.com` | API root for GitHub Enterprise |

`auth.json` and `session.sqlite` live in the data directory. Checkouts live in `checkouts/<owner>/<repo>/<sha>`.

## Development

```bash
npm ci
npm run build
npm test
npm run e2e
```

Tests use pi-ai's faux model and an in-memory GitHub client. They cover webhook signatures, SHA dedupe, idempotent posting, a crash between generation and posting, a crash after GitHub accepted the write, a webhook-to-comment pass over `test/fixtures/repo`, schema validation, confidence and path filtering, fingerprint dedupe and fixed marking, and comment rendering.

Live Codex OAuth and a real GitHub App are not exercised here. Pi Durable is experimental and its API can change between releases. This repo pins `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` at 1.1.0.

## License

MIT. See [LICENSE](LICENSE).
