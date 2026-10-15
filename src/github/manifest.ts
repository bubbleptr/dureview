import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { publicAuthError } from "../auth/reveal.js";
import { parseStoredGitHubApp, type StoredGitHubApp } from "./app-file.js";
import { githubWebOrigin } from "./web.js";

export const GITHUB_SETUP_COOKIE = "dureview_github_setup";

const STATE_BYTES = 32;

export type ManifestDocument = {
  name: string;
  url: string;
  description: string;
  public: false;
  redirect_url: string;
  setup_url: string;
  hook_attributes: { url: string; active: true };
  default_permissions: {
    contents: "read";
    issues: "write";
    pull_requests: "write";
    checks: "write";
  };
  default_events: ["pull_request", "issue_comment"];
  request_oauth_on_install: false;
};

export function newSetupState(): string {
  return randomBytes(STATE_BYTES).toString("hex");
}

export function githubSetupCookie(state: string): string {
  return `${GITHUB_SETUP_COOKIE}=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`;
}

export function clearGitHubSetupCookie(): string {
  return `${GITHUB_SETUP_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readSetupState(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const prefix = `${GITHUB_SETUP_COOKIE}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length);
    if (!/^[a-f0-9]{64}$/.test(value)) return undefined;
    return value;
  }
  return undefined;
}

export function statesMatch(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

/** Blank is the signed-in user. A slug creates the app on that organization. */
export function parseGitHubOrg(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (!/^[A-Za-z0-9-]{1,39}$/.test(trimmed)) return undefined;
  return trimmed;
}

export function manifestCreateUrl(apiUrl: string, org: string): string | null {
  const web = githubWebOrigin(apiUrl);
  if (!web) return null;
  if (org === "") return `${web}/settings/apps/new`;
  return `${web}/organizations/${org}/settings/apps/new`;
}

export function manifestOrigin(request: Request): { ok: true; origin: string } | { ok: false; error: string } {
  const url = new URL(request.url);
  const forwardedProto = headerToken(request.headers.get("x-forwarded-proto"));
  const proto = forwardedProto || url.protocol.replace(":", "");
  if (proto !== "https" && proto !== "http") {
    return { ok: false, error: "Open settings over https so GitHub can call the webhook." };
  }
  const host = headerToken(request.headers.get("x-forwarded-host")) || request.headers.get("host") || url.host;
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) || host.length > 255) {
    return { ok: false, error: "Open settings over https so GitHub can call the webhook." };
  }
  const origin = `${proto}://${host}`;
  const local = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  if (proto !== "https" && !local) {
    return { ok: false, error: "Open settings over https so GitHub can call the webhook." };
  }
  return { ok: true, origin };
}

export function buildManifest(origin: string, state: string): ManifestDocument {
  return {
    name: "dureview",
    url: `${origin}/ui`,
    description: "Adversarial pull request review",
    public: false,
    redirect_url: `${origin}/ui/settings?setup=github&state=${state}`,
    setup_url: `${origin}/ui/settings`,
    hook_attributes: { url: `${origin}/webhook`, active: true },
    default_permissions: {
      contents: "read",
      issues: "write",
      pull_requests: "write",
      checks: "write",
    },
    default_events: ["pull_request", "issue_comment"],
    request_oauth_on_install: false,
  };
}

export function manifestHandoffPage(action: string, manifest: ManifestDocument): string {
  const payload = escapeAttr(JSON.stringify(manifest));
  const target = escapeAttr(action);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Create GitHub App · dureview</title></head><body><p>Continue to GitHub to create the app.</p><form id="manifest" method="post" action="${target}"><input type="hidden" name="manifest" value="${payload}"><button type="submit">Continue to GitHub</button></form><script>document.getElementById("manifest").submit()</script></body></html>`;
}

export function handoffResponse(html: string, setCookie: string, formAction: string): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": handoffCsp(formAction),
    "set-cookie": setCookie,
  });
  return new Response(html, { status: 200, headers });
}

function handoffCsp(formAction: string): string {
  const target = githubWebOrigin(formAction) === formAction ? formAction : "'none'";
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action ${target}; base-uri 'none'; frame-ancestors 'none'`;
}

export function parseManifestCode(value: string | null): string | undefined {
  if (!value || !/^[A-Za-z0-9_-]{8,200}$/.test(value)) return undefined;
  return value;
}

export async function exchangeAppManifest(input: {
  code: string;
  apiUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<StoredGitHubApp> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.apiUrl}/app-manifests/${input.code}/conversions`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "dureview",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 180);
    throw new Error(publicAuthError(new Error(`GitHub could not create the app (${response.status}). ${detail}`)));
  }
  const payload: unknown = await response.json();
  const app = manifestToStored(payload);
  if (!app) throw new Error("GitHub returned an app this server could not store.");
  return app;
}

function manifestToStored(payload: unknown): StoredGitHubApp | undefined {
  if (!isRecord(payload)) return undefined;
  return parseStoredGitHubApp({
    appId: payload.id,
    privateKey: payload.pem,
    webhookSecret: payload.webhook_secret,
    slug: payload.slug,
    name: payload.name,
    htmlUrl: typeof payload.html_url === "string" ? payload.html_url : "",
  });
}

function headerToken(value: string | null): string {
  return value?.split(",")[0]?.trim() ?? "";
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
