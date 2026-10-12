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

The same `owner/repo#number@sha` is not reviewed twice. A later push (a new SHA) updates the existing summary comment and adds a new inline review.

## What the model sees

Each review is one Pi Durable task:

1. **prepare** checks out the head and loads the diff plus an optional `.dureview.md`.
2. **review** runs a conversation with `read`, `grep`, and `submit_review`. No write, edit, or shell tool is offered.
3. **post** publishes to GitHub.

The default prompt is adversarial: real bugs, security issues, edge cases, broken assumptions, and missing error handling. No praise and no style comments. Every finding needs a file, a line in the head revision, and why that line is wrong.

`read` and `grep` are marked `replay: "safe"` (pi-durable 1.0's built-in `read` tool is not). Comment posting is **not** replay-safe. The post phase lists issue comments and reviews first. A hidden marker carries the task id:

```html
<!-- dureview:summary owner/repo#42 -->
<!-- dureview:task 17 -->
<!-- dureview:inline 17 -->
```

If the process dies after GitHub accepted a write, resume sees the marker and does not post a second copy. The summary marker is per pull request, so the next push updates that comment instead of adding another.

Findings on lines that are not part of the diff stay in the summary. Inline comments are a pull request review with `event: COMMENT` on `side: RIGHT`.

## `.dureview.md`

Optional file at the repository root. Plain markdown. It is appended to the review prompt for that checkout. Example:

```markdown
# Review rules

- Flag missing error handling on payment and auth paths.
- This service assumes `user` is non-null after `loadUser()`.
- Ignore formatting and naming.
```

Keep it short. It is sent on every review of that repository.

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

Tests use pi-ai's faux model and an in-memory GitHub client. They cover webhook signatures, SHA dedupe, idempotent posting, a crash between generation and posting, a crash after GitHub accepted the write, and a webhook-to-comment pass over `test/fixtures/repo`.

Live Codex OAuth and a real GitHub App are not exercised here. Pi Durable is experimental and its API can change between releases. This repo pins `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and `@earendil-works/chord` at 1.1.0.

## License

MIT. See [LICENSE](LICENSE).
