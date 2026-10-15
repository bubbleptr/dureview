import { appJwt } from "./client.js";

export type InstallationProbe = {
  slug: string | null;
  accounts: string[];
  error: string | null;
};

/** Best-effort installation list for the settings page. Failure stays on the page and does not throw. */
export async function probeInstallations(input: {
  apiUrl: string;
  appId: string;
  privateKey: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<InstallationProbe> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const signal = input.signal ?? AbortSignal.timeout(4000);
  try {
    const jwt = appJwt(input.appId, input.privateKey);
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "dureview",
      "x-github-api-version": "2022-11-28",
    };
    const appResponse = await fetchImpl(`${input.apiUrl}/app`, { headers, signal });
    if (!appResponse.ok) {
      return { slug: null, accounts: [], error: `GitHub could not read the app (${appResponse.status}).` };
    }
    const appPayload: unknown = await appResponse.json();
    const slug = isRecord(appPayload) && typeof appPayload.slug === "string" && /^[A-Za-z0-9-]+$/.test(appPayload.slug) ? appPayload.slug : null;
    const listResponse = await fetchImpl(`${input.apiUrl}/app/installations?per_page=100`, { headers, signal });
    if (!listResponse.ok) {
      return { slug, accounts: [], error: `GitHub could not list installations (${listResponse.status}).` };
    }
    const listPayload: unknown = await listResponse.json();
    return { slug, accounts: accountLogins(listPayload), error: null };
  } catch {
    return { slug: null, accounts: [], error: "GitHub could not list installations." };
  }
}

function accountLogins(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  const names: string[] = [];
  for (const row of payload) {
    if (!isRecord(row) || !isRecord(row.account)) continue;
    const login = row.account.login;
    if (typeof login !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(login)) continue;
    names.push(login);
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
