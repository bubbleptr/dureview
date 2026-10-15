import type { ApiKeyView, GitHubSetupView, SettingsFieldView } from "../settings/page.js";
import type { SettingsSection } from "./settings-sections.js";

export const settingsCopy = {
  title: "Settings",
  loginTitle: "登录 · dureview",
  documentTitle: "Settings · dureview",
  sectionsLabel: "Settings sections",
  sectionLabel: "Section",
  save: "Save",
  reset: "Reset",
  yes: "Yes",
  no: "No",
  notSet: "Not set",
  advanced: "Advanced",
  section: {
    models: "Models & credentials",
    github: "GitHub",
    review: "Review",
    system: "System",
  } satisfies Record<SettingsSection, string>,
  lead: {
    models: "Provider, model, subscription logins, and API keys.",
    github: "GitHub App connection, installations, and setup.",
    review: "When reviews run, and how diffs look in this browser.",
    system: "A saved value wins over the environment variable, which wins over the built-in default.",
  } satisfies Record<SettingsSection, string>,
  banners: {
    saved: "Saved. New reviews use these settings.",
  },
  modelCard: {
    title: "Active model",
    description: "Changes apply to new reviews. A review that is already running keeps the model and thinking it started with.",
  },
  subscriptions: {
    title: "Subscription logins",
    description: "Device code only. This server shows a verification page and a code, then waits until the provider finishes.",
    unreadable: "The credential file could not be read.",
    notSignedIn: "Not signed in.",
    signedIn: "Signed in",
    as: "as",
    accessExpires: "Access expires",
    logIn: "Log in",
    logInAgain: "Log in again",
    logOut: "Log out",
    enterprise: "Enterprise domain",
    enterprisePlaceholder: "Blank for github.com",
    starting: "Starting device login…",
    openVerification: "Open",
    verificationPage: "the verification page",
    enterCode: "and enter this code.",
    copyCode: "Copy code",
    codeExpires: "Code expires",
  },
  apiKeys: {
    title: "API keys",
    description: "A saved key overrides the environment variable. After you save, this page shows that the key is configured and its last four characters.",
    key: "API key",
    keepPlaceholder: "Leave blank to keep the saved key",
    save: "Save key",
    remove: "Remove saved key",
    saved: "Saved",
    environment: "Environment",
  },
  github: {
    connection: "Connection",
    setup: "Setup",
    setupDescription: "Create the app on GitHub with the permissions and webhook this server needs. Environment variables still take precedence over a saved app.",
    app: "GitHub App",
    appHelp: "Whether this process was started with a GitHub App id and private key.",
    token: "GitHub token",
    tokenHelp: "Whether this process was started with GITHUB_TOKEN.",
    appId: "App id",
    appIdHelp: "The GitHub App this server is using.",
    installations: "Installed repos",
    installationsUnknown: "Listed after this server can query the GitHub App.",
    noneInstalled: "No installations yet.",
    installMore: "Install on more repos",
    org: "Organization",
    orgPlaceholder: "Blank for your user",
    create: "Create GitHub App",
    createNew: "Create a new GitHub App",
    remove: "Remove saved app",
    unreadable: "The saved GitHub App could not be read.",
    envApp: "Using the GitHub App from the environment.",
    envTokenSaved: "Using GITHUB_TOKEN from the environment. A saved GitHub App is stored and is not used while that variable is set.",
    envToken: "Using GITHUB_TOKEN from the environment.",
    savedApp: "Using the GitHub App saved on this page.",
    noApp: "No GitHub App yet.",
    webhookEnv: "Webhook secret is set in the environment.",
    webhookMissing: "Webhook secret is not set. Creating the GitHub App stores one.",
    privateKeyEnv: "Private key is set in the environment.",
    privateKeySaved: "Private key is saved.",
    privateKeyMissing: "Private key is not set.",
    webhook: "Webhook secret",
    privateKey: "Private key",
  },
  review: {
    card: "Review",
    cardDescription: "The trigger and draft skip apply when the base branch does not override them. Diff style is saved in this browser.",
    postInformational: "Post informational",
    postInformationalHelp: "Informational flags stay off unless the base branch sets post_informational. They still do not request changes.",
    postInformationalValue: "false",
    diff: "Diff view",
    diffHelp: "Unified or split. Saved in this browser, not on the server.",
    diffGroup: "Diff view",
    unified: "Unified",
    split: "Split",
    drafts: "Skip draft pull requests",
    fileDefaults: "Repository file",
    fileDefaultsHelp: "These .dureview.md keys keep the defaults below unless the base branch sets them. This page does not store them.",
  },
  triggers: [
    { value: "manual", label: "Manual" },
    { value: "once", label: "Once" },
    { value: "auto", label: "Auto" },
  ],
  fileDefaults: [
    { key: "profile", value: "default", help: "quiet, default, or loud." },
    { key: "summary", value: "false", help: "Also post one summary comment when true." },
    { key: "language", value: "en", help: "en or zh for finding prose." },
    { key: "min_confidence", value: "0.5", help: "Drop findings below this." },
    { key: "min_inline_priority", value: "2", help: "Highest priority that is still inlined. 0 is P0 only." },
    { key: "p2_inline_min_confidence", value: "0.7", help: "P2 confidence required for an inline comment." },
    { key: "max_inline", value: "10", help: "New inline comments per run." },
  ],
  system: {
    runtime: "Runtime",
    runtimeHelp: "Read-only facts for this process.",
    version: "Version",
    versionHelp: "The dureview package version.",
    uptime: "Uptime",
    uptimeHelp: "How long this process has been running.",
    dataDir: "Data directory",
    dataDirHelp: "Credentials, reviews, and checkouts. Set with DUREVIEW_DATA_DIR.",
    running: "Running",
    runningHelp: "Provider, model, and thinking this process is using.",
    unavailable: "Runtime details are unavailable.",
    sources: "Setting sources",
    sourcesHelp: "Override, then the environment variable, then the built-in default.",
    audit: "Recent changes",
    auditEmpty: "No changes yet.",
    when: "When",
    who: "Who",
    setting: "Setting",
    change: "Change",
  },
} as const;

export function sectionDocumentTitle(section: SettingsSection): string {
  return `${settingsCopy.section[section]} · ${settingsCopy.documentTitle}`;
}

export function sourceSentence(field: SettingsFieldView): string {
  const where =
    field.source === "override" ? "Saved on this page." : field.source === "env" ? "From the environment." : "Built-in default.";
  const parts = [`Effective ${field.value}.`, where];
  if (field.env !== null && field.source !== "env") parts.push(`Environment is ${field.env}.`);
  if (field.source !== "default") parts.push(`Built-in default is ${field.builtin}.`);
  return parts.join(" ");
}

export function apiKeySentence(row: ApiKeyView): string {
  if (row.stored && row.tail && row.fromEnv) return `Configured, ending in ${row.tail}. This saved key overrides ${row.envName}.`;
  if (row.stored && row.tail) return `Configured, ending in ${row.tail}.`;
  if (row.fromEnv) return `Configured in the environment (${row.envName}). A saved key overrides it.`;
  return "Not configured.";
}

export function githubSentence(github: GitHubSetupView): string {
  if (github.kind === "environment-app") return settingsCopy.github.envApp;
  if (github.kind === "environment-token") return github.saved ? settingsCopy.github.envTokenSaved : settingsCopy.github.envToken;
  if (github.kind === "saved") return settingsCopy.github.savedApp;
  return settingsCopy.github.noApp;
}

export function webhookSentence(github: GitHubSetupView): string {
  if (github.webhook === "environment") return settingsCopy.github.webhookEnv;
  if (github.webhook === "saved" && github.webhookTail) return `Webhook secret is saved, ending in ${github.webhookTail}.`;
  return settingsCopy.github.webhookMissing;
}

export function privateKeySentence(github: GitHubSetupView): string {
  if (github.privateKey === "environment") return settingsCopy.github.privateKeyEnv;
  if (github.privateKey === "saved") return settingsCopy.github.privateKeySaved;
  return settingsCopy.github.privateKeyMissing;
}

export function installationsSentence(names: string[], extra: number): string {
  const listed = names.join(", ");
  return extra > 0 ? `Installed on ${listed}, and ${extra} more.` : `Installed on ${listed}.`;
}

export function resetToSentence(previous: string | null, value: string | null, action: "set" | "reset"): string {
  if (action === "reset") return `${previous ?? "override"} → reset`;
  return `${previous ?? "unset"} → ${value ?? ""}`;
}

export function resetLabel(label: string): string {
  return `Reset ${label}`;
}
