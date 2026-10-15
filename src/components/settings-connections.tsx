import { useEffect, useState } from "react";
import type { ApiKeyView, ConsoleView, LoginView, SubscriptionView } from "../settings/page.js";
import { formatTime } from "../ui/page.js";
import { LocalTime } from "./local-time.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

export function Connections({ console: consoleView, csrf }: { console: ConsoleView; csrf: string }) {
  return (
    <div className="flex flex-col gap-8">
      <Subscriptions rows={consoleView.subscriptions} logins={consoleView.logins} csrf={csrf} />
      <ApiKeys rows={consoleView.apiKeys} csrf={csrf} />
      <GitHubSetup github={consoleView.github} csrf={csrf} />
    </div>
  );
}

function CsrfField({ token }: { token: string }) {
  return <input type="hidden" name="csrf" value={token} />;
}

function Subscriptions({ rows, logins, csrf }: { rows: SubscriptionView[]; logins: LoginView[]; csrf: string }) {
  const [live, setLive] = useState(logins);
  const pending = live.some((login) => login.phase === "starting" || login.phase === "code");
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    const tick = async () => {
      try {
        const response = await fetch("/ui/settings?poll=1", { headers: { accept: "application/json" } });
        if (response.status === 401) return;
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (stop || !isLoginList(body)) return;
        if (body.logins.some((login) => login.phase === "done")) {
          window.location.assign("/ui/settings?login=ready");
          return;
        }
        setLive(body.logins);
      } catch {
        return;
      }
    };
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [pending]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Subscription logins</h2>
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">
          Device code only. This server shows a verification page and a code, then waits until the provider finishes. A localhost callback is not used.
        </p>
      </div>
      {rows.map((row) => (
        <SubscriptionRow key={row.provider} row={row} login={live.find((login) => login.provider === row.provider) ?? null} csrf={csrf} />
      ))}
    </section>
  );
}

function SubscriptionRow({ row, login, csrf }: { row: SubscriptionView; login: LoginView | null; csrf: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{row.label}</h3>
        <span className="font-mono text-xs text-muted-foreground">{row.provider}</span>
      </div>
      {row.unreadable ? (
        <p className="text-sm text-destructive" role="alert">
          The credential file could not be read.
        </p>
      ) : row.present ? (
        <p className="text-sm text-muted-foreground">
          Signed in
          {row.account ? (
            <>
              {" as "}
              <span className="font-mono text-foreground">{row.account}</span>
            </>
          ) : null}
          {row.expiresAt ? (
            <>
              {". Access expires "}
              <LocalTime iso={row.expiresAt} label={formatTime(row.expiresAt)} />
            </>
          ) : null}
          .
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Not signed in.</p>
      )}
      {login?.phase === "error" && login.message ? (
        <p className="text-sm text-destructive" role="alert">
          {login.message}
        </p>
      ) : null}
      {login && (login.phase === "starting" || login.phase === "code") ? <DeviceCode login={login} /> : null}
      <div className="flex flex-wrap items-end gap-2">
        <form className="flex flex-wrap items-end gap-2" method="post" action="/ui/settings">
          <CsrfField token={csrf} />
          <input type="hidden" name="action" value="login" />
          <input type="hidden" name="provider" value={row.provider} />
          {row.provider === "github-copilot" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="github-enterprise">Enterprise domain</Label>
              <Input id="github-enterprise" name="enterprise" placeholder="Blank for github.com" autoComplete="off" />
            </div>
          ) : null}
          <Button type="submit">{row.present ? "Log in again" : "Log in"}</Button>
        </form>
        {row.present ? (
          <form method="post" action="/ui/settings">
            <CsrfField token={csrf} />
            <input type="hidden" name="action" value="logout" />
            <input type="hidden" name="provider" value={row.provider} />
            <Button type="submit" variant="outline">
              Log out
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function DeviceCode({ login }: { login: LoginView }) {
  return (
    <div className="flex flex-col gap-1" aria-live="polite">
      {login.phase === "starting" ? <p className="text-sm text-muted-foreground">Starting device login…</p> : null}
      {login.phase === "code" && login.verificationUri && login.userCode ? (
        <>
          <p className="text-sm">
            Open{" "}
            <a className="underline" href={login.verificationUri} rel="noreferrer">
              the verification page
            </a>{" "}
            and enter this code.
          </p>
          <p className="font-mono text-base">{login.userCode}</p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(login.userCode ?? "")}>
              Copy code
            </Button>
          </div>
          {login.expiresAt ? (
            <p className="text-xs text-muted-foreground">
              Code expires <LocalTime iso={login.expiresAt} label={formatTime(login.expiresAt)} />.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ApiKeys({ rows, csrf }: { rows: ApiKeyView[]; csrf: string }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">API keys</h2>
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">
          A saved key overrides the environment variable. After you save, this page shows that the key is configured and its last four characters.
        </p>
      </div>
      {rows.map((row) => (
        <div key={row.provider} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{row.label}</h3>
            <span className="font-mono text-xs text-muted-foreground">{row.envName}</span>
            {row.stored ? <Badge variant="outline">Saved</Badge> : null}
            {row.fromEnv ? <Badge variant="outline">Environment</Badge> : null}
          </div>
          <p className="text-sm text-muted-foreground">{apiKeySentence(row)}</p>
          <form className="flex flex-wrap items-end gap-2" method="post" action="/ui/settings">
            <CsrfField token={csrf} />
            <input type="hidden" name="action" value="api-key" />
            <input type="hidden" name="provider" value={row.provider} />
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <Label htmlFor={`key-${row.provider}`}>API key</Label>
              <Input id={`key-${row.provider}`} name="key" type="password" autoComplete="off" placeholder={row.stored ? "Leave blank to keep the saved key" : ""} />
            </div>
            <Button type="submit">Save key</Button>
          </form>
          {row.stored ? (
            <form method="post" action="/ui/settings">
              <CsrfField token={csrf} />
              <input type="hidden" name="action" value="api-key-clear" />
              <input type="hidden" name="provider" value={row.provider} />
              <Button type="submit" variant="outline" size="sm">
                Remove saved key
              </Button>
            </form>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function GitHubSetup({ github, csrf }: { github: ConsoleView["github"]; csrf: string }) {
  const listed = github.installations?.length ?? 0;
  const extra = github.installationCount === null ? 0 : github.installationCount - listed;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">GitHub App</h2>
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">
          Create the app on GitHub with the permissions and webhook this server needs. Environment variables still take precedence over a saved app.
        </p>
      </div>
      {github.unreadable ? (
        <p className="text-sm text-destructive" role="alert">
          The saved GitHub App could not be read.
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{githubSentence(github)}</p>
      {github.appId ? (
        <p className="text-sm">
          App id <span className="font-mono">{github.appId}</span>
          {github.name ? ` · ${github.name}` : null}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{webhookSentence(github)}</p>
      <p className="text-sm text-muted-foreground">{privateKeySentence(github)}</p>
      {github.installationError ? (
        <p className="text-sm text-destructive" role="alert">
          {github.installationError}
        </p>
      ) : null}
      {github.installationCount === null ? null : github.installationCount === 0 ? (
        <p className="text-sm text-muted-foreground">No installations yet.</p>
      ) : (
        <p className="text-sm">
          Installed on {github.installations?.join(", ")}
          {extra > 0 ? `, and ${extra} more` : ""}.
        </p>
      )}
      {github.installUrl ? (
        <p className="text-sm">
          <a className="underline" href={github.installUrl} rel="noreferrer">
            Install on more repos
          </a>
        </p>
      ) : null}
      {github.kind === "environment-app" ? null : (
        <form className="flex flex-wrap items-end gap-2" method="post" action="/ui/settings">
          <CsrfField token={csrf} />
          <input type="hidden" name="action" value="github-manifest" />
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <Label htmlFor="github-org">Organization</Label>
            <Input id="github-org" name="org" autoComplete="off" placeholder="Blank for your user" />
          </div>
          <Button type="submit">{github.kind === "saved" ? "Create a new GitHub App" : "Create GitHub App"}</Button>
        </form>
      )}
      {github.saved ? (
        <form method="post" action="/ui/settings">
          <CsrfField token={csrf} />
          <input type="hidden" name="action" value="github-clear" />
          <Button type="submit" variant="outline" size="sm">
            Remove saved app
          </Button>
        </form>
      ) : null}
    </section>
  );
}

function apiKeySentence(row: ApiKeyView): string {
  if (row.stored && row.tail && row.fromEnv) return `Configured, ending in ${row.tail}. This saved key overrides ${row.envName}.`;
  if (row.stored && row.tail) return `Configured, ending in ${row.tail}.`;
  if (row.fromEnv) return `Configured in the environment (${row.envName}). A saved key overrides it.`;
  return "Not configured.";
}

function githubSentence(github: ConsoleView["github"]): string {
  if (github.kind === "environment-app") return "Using the GitHub App from the environment.";
  if (github.kind === "environment-token") {
    return github.saved
      ? "Using GITHUB_TOKEN from the environment. A saved GitHub App is stored and is not used while that variable is set."
      : "Using GITHUB_TOKEN from the environment.";
  }
  if (github.kind === "saved") return "Using the GitHub App saved on this page.";
  return "No GitHub App yet.";
}

function webhookSentence(github: ConsoleView["github"]): string {
  if (github.webhook === "environment") return "Webhook secret is set in the environment.";
  if (github.webhook === "saved" && github.webhookTail) return `Webhook secret is saved, ending in ${github.webhookTail}.`;
  return "Webhook secret is not set. Creating the GitHub App stores one.";
}

function privateKeySentence(github: ConsoleView["github"]): string {
  if (github.privateKey === "environment") return "Private key is set in the environment.";
  if (github.privateKey === "saved") return "Private key is saved.";
  return "Private key is not set.";
}

function isLoginList(value: unknown): value is { logins: LoginView[] } {
  if (typeof value !== "object" || value === null || !("logins" in value)) return false;
  const logins = value.logins;
  return Array.isArray(logins);
}
