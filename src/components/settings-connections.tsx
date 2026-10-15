import { useEffect, useState } from "react";
import type { ApiKeyView, ConsoleView, LoginView, SubscriptionView } from "../settings/page.js";
import { formatTime } from "../ui/page.js";
import {
  apiKeySentence,
  githubSentence,
  installationsSentence,
  privateKeySentence,
  settingsCopy,
  webhookSentence,
} from "../ui/settings-copy.js";
import type { SettingsSection } from "../ui/settings-sections.js";
import type { ShellStatus } from "../ui/shell-status.js";
import { LocalTime } from "./local-time.js";
import { SettingRow, SettingsCard } from "./settings-row.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

export function Subscriptions({
  rows,
  logins,
  csrf,
  status,
  section,
}: {
  rows: SubscriptionView[];
  logins: LoginView[];
  csrf: string;
  status: ShellStatus | null;
  section: SettingsSection;
}) {
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
          window.location.assign("/ui/settings/models?login=ready");
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

  const codexRow = rows.some((row) => row.provider === "openai-codex");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{settingsCopy.subscriptions.title}</h3>
        <p className="max-w-prose text-sm leading-5 text-muted-foreground">{settingsCopy.subscriptions.description}</p>
      </div>
      {rows.map((row) => (
        <SubscriptionCard
          key={row.provider}
          row={row}
          login={live.find((login) => login.provider === row.provider) ?? null}
          csrf={csrf}
          status={status}
          section={section}
        />
      ))}
      {!codexRow && status ? <CodexLine status={status} /> : null}
    </div>
  );
}

function SubscriptionCard({
  row,
  login,
  csrf,
  status,
  section,
}: {
  row: SubscriptionView;
  login: LoginView | null;
  csrf: string;
  status: ShellStatus | null;
  section: SettingsSection;
}) {
  const copy = settingsCopy.subscriptions;
  return (
    <SettingsCard title={row.label} description={<span className="font-mono">{row.provider}</span>}>
      <div className="flex flex-col gap-4 py-5">
        {row.unreadable ? (
          <p className="text-sm text-destructive" role="alert">
            {copy.unreadable}
          </p>
        ) : row.provider === "openai-codex" && status ? (
          <CodexLine status={status} />
        ) : (
          <SubscriptionStatus row={row} />
        )}
        {row.provider === "openai-codex" && status && row.account ? (
          <p className="text-sm text-muted-foreground">
            {copy.signedIn} {copy.as} <span className="font-mono text-foreground">{row.account}</span>.
          </p>
        ) : null}
        {login?.phase === "error" && login.message ? (
          <p className="text-sm text-destructive" role="alert">
            {login.message}
          </p>
        ) : null}
        {login && (login.phase === "starting" || login.phase === "code") ? <DeviceCode login={login} /> : null}
        <div className="flex flex-wrap items-end gap-2">
          <form className="flex flex-wrap items-end gap-2" method="post" action="/ui/settings">
            <CsrfField token={csrf} />
            <SectionField section={section} />
            <input type="hidden" name="action" value="login" />
            <input type="hidden" name="provider" value={row.provider} />
            {row.provider === "github-copilot" ? (
              <div className="flex min-w-48 flex-col gap-1.5">
                <Label htmlFor="github-enterprise" className="text-sm font-medium text-foreground">
                  {copy.enterprise}
                </Label>
                <Input id="github-enterprise" name="enterprise" placeholder={copy.enterprisePlaceholder} autoComplete="off" />
              </div>
            ) : null}
            <Button type="submit">{row.present ? copy.logInAgain : copy.logIn}</Button>
          </form>
          {row.present ? (
            <form method="post" action="/ui/settings">
              <CsrfField token={csrf} />
              <SectionField section={section} />
              <input type="hidden" name="action" value="logout" />
              <input type="hidden" name="provider" value={row.provider} />
              <Button type="submit" variant="outline">
                {copy.logOut}
              </Button>
            </form>
          ) : null}
        </div>
      </div>
    </SettingsCard>
  );
}

function SubscriptionStatus({ row }: { row: SubscriptionView }) {
  const copy = settingsCopy.subscriptions;
  if (row.unreadable) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {copy.unreadable}
      </p>
    );
  }
  if (!row.present) return <p className="text-sm text-muted-foreground">{copy.notSignedIn}</p>;
  return (
    <p className="text-sm text-muted-foreground">
      {copy.signedIn}
      {row.account ? (
        <>
          {" "}
          {copy.as} <span className="font-mono text-foreground">{row.account}</span>
        </>
      ) : null}
      {row.expiresAt ? (
        <>
          {". "}
          {copy.accessExpires} <LocalTime iso={row.expiresAt} label={formatTime(row.expiresAt)} />
        </>
      ) : null}
      .
    </p>
  );
}

function CodexLine({ status }: { status: ShellStatus }) {
  if (status.codex.kind === "plain") return <p className="text-sm text-muted-foreground">{status.codex.text}</p>;
  return (
    <p className="text-sm text-muted-foreground">
      {status.codex.lead}
      <LocalTime iso={status.codex.iso} label={status.codex.label} />
    </p>
  );
}

function DeviceCode({ login }: { login: LoginView }) {
  const copy = settingsCopy.subscriptions;
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      {login.phase === "starting" ? <p className="text-sm text-muted-foreground">{copy.starting}</p> : null}
      {login.phase === "code" && login.verificationUri && login.userCode ? (
        <>
          <p className="text-sm">
            {copy.openVerification}{" "}
            <a className="underline" href={login.verificationUri} rel="noreferrer">
              {copy.verificationPage}
            </a>{" "}
            {copy.enterCode}
          </p>
          <p className="font-mono text-base">{login.userCode}</p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(login.userCode ?? "")}>
              {copy.copyCode}
            </Button>
          </div>
          {login.expiresAt ? (
            <p className="text-xs text-muted-foreground">
              {copy.codeExpires} <LocalTime iso={login.expiresAt} label={formatTime(login.expiresAt)} />.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function ApiKeys({ rows, csrf, section }: { rows: ApiKeyView[]; csrf: string; section: SettingsSection }) {
  const copy = settingsCopy.apiKeys;
  return (
    <SettingsCard title={copy.title} description={copy.description}>
      {rows.map((row) => (
        <SettingRow
          key={row.provider}
          title={row.label}
          htmlFor={`key-${row.provider}`}
          description={
            <>
              <span className="font-mono">{row.envName}</span>
              {". "}
              {apiKeySentence(row)}
            </>
          }
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            {row.stored ? <Badge variant="outline">{copy.saved}</Badge> : null}
            {row.fromEnv ? <Badge variant="outline">{copy.environment}</Badge> : null}
          </div>
          <form className="flex w-full flex-col gap-2" method="post" action="/ui/settings">
            <CsrfField token={csrf} />
            <SectionField section={section} />
            <input type="hidden" name="action" value="api-key" />
            <input type="hidden" name="provider" value={row.provider} />
            <Input
              id={`key-${row.provider}`}
              name="key"
              type="password"
              autoComplete="off"
              placeholder={row.stored ? copy.keepPlaceholder : ""}
            />
            <Button type="submit">{copy.save}</Button>
          </form>
          {row.stored ? (
            <form method="post" action="/ui/settings">
              <CsrfField token={csrf} />
              <SectionField section={section} />
              <input type="hidden" name="action" value="api-key-clear" />
              <input type="hidden" name="provider" value={row.provider} />
              <Button type="submit" variant="outline" size="sm">
                {copy.remove}
              </Button>
            </form>
          ) : null}
        </SettingRow>
      ))}
    </SettingsCard>
  );
}

export function GitHubSetup({
  github,
  csrf,
  status,
  section,
}: {
  github: ConsoleView["github"];
  csrf: string;
  status: ShellStatus | null;
  section: SettingsSection;
}) {
  const copy = settingsCopy.github;
  const listed = github.installations ?? [];
  const extra = github.installationCount === null ? 0 : github.installationCount - listed.length;
  return (
    <div className="flex flex-col gap-8">
      <SettingsCard title={copy.connection} description={githubSentence(github)}>
        {github.unreadable ? (
          <p className="py-5 text-sm text-destructive" role="alert">
            {copy.unreadable}
          </p>
        ) : null}
        {status ? (
          <SettingRow title={copy.app} description={copy.appHelp}>
            <span className="text-sm font-medium">{status.githubApp ? settingsCopy.yes : settingsCopy.no}</span>
          </SettingRow>
        ) : null}
        {status ? (
          <SettingRow title={copy.token} description={copy.tokenHelp}>
            <span className="text-sm font-medium">{status.githubToken ? settingsCopy.yes : settingsCopy.no}</span>
          </SettingRow>
        ) : null}
        {github.appId ? (
          <SettingRow title={copy.appId} description={copy.appIdHelp}>
            <span className="font-mono text-sm">
              {github.appId}
              {github.name ? ` · ${github.name}` : ""}
            </span>
          </SettingRow>
        ) : null}
        <SettingRow title={copy.webhook} description={webhookSentence(github)}>
          <span className="text-sm font-medium">{github.webhook === "missing" ? settingsCopy.no : settingsCopy.yes}</span>
        </SettingRow>
        <SettingRow title={copy.privateKey} description={privateKeySentence(github)}>
          <span className="text-sm font-medium">{github.privateKey === "missing" ? settingsCopy.no : settingsCopy.yes}</span>
        </SettingRow>
        <SettingRow
          title={copy.installations}
          description={
            github.installationCount === null
              ? copy.installationsUnknown
              : github.installationCount === 0
                ? copy.noneInstalled
                : installationsSentence(listed, extra)
          }
        >
          {github.installUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={github.installUrl} rel="noreferrer">
                {copy.installMore}
              </a>
            </Button>
          ) : null}
        </SettingRow>
        {github.installationError ? (
          <p className="py-5 text-sm text-destructive" role="alert">
            {github.installationError}
          </p>
        ) : null}
      </SettingsCard>
      <SettingsCard title={copy.setup} description={copy.setupDescription}>
        <div className="flex flex-col gap-4 py-5">
          {github.kind === "environment-app" ? null : (
            <form className="flex flex-col gap-3 sm:flex-row sm:items-end" method="post" action="/ui/settings">
              <CsrfField token={csrf} />
              <SectionField section={section} />
              <input type="hidden" name="action" value="github-manifest" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor="github-org" className="text-sm font-medium text-foreground">
                  {copy.org}
                </Label>
                <Input id="github-org" name="org" autoComplete="off" placeholder={copy.orgPlaceholder} />
              </div>
              <Button type="submit">{github.kind === "saved" ? copy.createNew : copy.create}</Button>
            </form>
          )}
          {github.saved ? (
            <form method="post" action="/ui/settings">
              <CsrfField token={csrf} />
              <SectionField section={section} />
              <input type="hidden" name="action" value="github-clear" />
              <Button type="submit" variant="outline" size="sm">
                {copy.remove}
              </Button>
            </form>
          ) : null}
        </div>
      </SettingsCard>
    </div>
  );
}

function CsrfField({ token }: { token: string }) {
  return <input type="hidden" name="csrf" value={token} />;
}

function SectionField({ section }: { section: SettingsSection }) {
  return <input type="hidden" name="section" value={section} />;
}

function isLoginList(value: unknown): value is { logins: LoginView[] } {
  if (typeof value !== "object" || value === null || !("logins" in value)) return false;
  const logins = value.logins;
  return Array.isArray(logins);
}
