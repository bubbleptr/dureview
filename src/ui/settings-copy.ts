import type { ApiKeyView, GitHubSetupView, SettingsFieldView } from "../settings/page.js";
import { fill } from "./format.js";
import type { Locale, MessageTree } from "./locale.js";
import type { SettingsSection } from "./settings-sections.js";

export const settingsCopy = {
  title: "Settings",
  loginTitle: "Sign in · dureview",
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
  fields: {
    provider: {
      label: "Provider",
      help: "Provider for new reviews. When this variable is unset, a stored Codex login is used, otherwise OpenAI when OPENAI_API_KEY is set.",
    },
    model: {
      label: "Model",
      help: "Model id from the pi-ai catalog for the active provider. New reviews use this model.",
    },
    thinking: {
      label: "Thinking",
      help: "Thinking level for that model. A review keeps the level it started with.",
    },
    defaultTrigger: {
      label: "Default trigger",
      help: "Used when the base branch has no .dureview.md, or the file does not set trigger.",
    },
    skipDrafts: {
      label: "Skip drafts",
      help: "Skip draft pull requests even when .dureview.md sets drafts: true.",
    },
    checkoutTtlDays: {
      label: "Checkout TTL",
      help: "Delete checkouts older than this many days. 0 deletes every checkout no review is using. The next sweep picks this up.",
    },
    maxOutputTokens: {
      label: "Max output tokens",
      help: "Most tokens one model response may use. Each model call uses this cap.",
    },
  },
  sources: {
    override: "Override",
    env: "Environment",
    default: "Default",
  },
  effective: {
    value: "Effective {value}.",
    saved: "Saved on this page.",
    env: "From the environment.",
    builtin: "Built-in default.",
    envIs: "Environment is {env}.",
    builtinIs: "Built-in default is {builtin}.",
  },
  apiKeyText: {
    both: "Configured, ending in {tail}. This saved key overrides {env}.",
    stored: "Configured, ending in {tail}.",
    env: "Configured in the environment ({env}). A saved key overrides it.",
    missing: "Not configured.",
  },
  webhookSaved: "Webhook secret is saved, ending in {tail}.",
  installed: "Installed on {names}.",
  installedMore: "Installed on {names}, and {extra} more.",
  auditReset: "{previous} → reset",
  auditSet: "{previous} → {value}",
  auditOverride: "override",
  auditUnset: "unset",
  resetNamed: "Reset {label}",
} as const;

export type SettingsCopy = MessageTree<typeof settingsCopy>;

const settingsCopyZh = {
  title: "设置",
  loginTitle: "登录 · dureview",
  documentTitle: "设置 · dureview",
  sectionsLabel: "设置分区",
  sectionLabel: "分区",
  save: "保存",
  reset: "重置",
  yes: "是",
  no: "否",
  notSet: "未设置",
  advanced: "高级",
  section: {
    models: "模型与凭证",
    github: "GitHub",
    review: "审查",
    system: "系统",
  },
  lead: {
    models: "提供方、模型、订阅登录和 API 密钥。",
    github: "GitHub App 的连接、安装和创建。",
    review: "审查何时运行，以及这台浏览器里的 diff 样式。",
    system: "页面上保存的值优先于环境变量，环境变量优先于内置默认值。",
  },
  banners: {
    saved: "已保存。新的审查会使用这些设置。",
  },
  modelCard: {
    title: "当前模型",
    description: "只影响之后开始的审查。已经在跑的审查仍用开始时的模型和思考级别。",
  },
  subscriptions: {
    title: "订阅登录",
    description: "只用设备码。服务器给出验证页和验证码，然后等到提供方完成。",
    unreadable: "凭证文件无法读取。",
    notSignedIn: "未登录。",
    signedIn: "已登录",
    as: "账号",
    accessExpires: "访问到期",
    logIn: "登录",
    logInAgain: "重新登录",
    logOut: "退出",
    enterprise: "企业域名",
    enterprisePlaceholder: "github.com 请留空",
    starting: "正在开始设备登录…",
    openVerification: "打开",
    verificationPage: "验证页",
    enterCode: "并输入这个验证码。",
    copyCode: "复制验证码",
    codeExpires: "验证码到期",
  },
  apiKeys: {
    title: "API 密钥",
    description: "保存的密钥会覆盖环境变量。保存后，本页只显示已配置，以及末四位。",
    key: "API 密钥",
    keepPlaceholder: "留空则保留已保存的密钥",
    save: "保存密钥",
    remove: "移除已保存的密钥",
    saved: "已保存",
    environment: "环境变量",
  },
  github: {
    connection: "连接",
    setup: "创建",
    setupDescription: "在 GitHub 上创建应用，权限和 webhook 由这台服务器决定。环境变量仍优先于已保存的应用。",
    app: "GitHub App",
    appHelp: "这个进程启动时是否带了 GitHub App id 和私钥。",
    token: "GitHub token",
    tokenHelp: "这个进程启动时是否带了 GITHUB_TOKEN。",
    appId: "应用 id",
    appIdHelp: "这台服务器正在使用的 GitHub App。",
    installations: "已安装的仓库",
    installationsUnknown: "这台服务器能查询 GitHub App 之后才会列出。",
    noneInstalled: "还没有安装。",
    installMore: "安装到更多仓库",
    org: "组织",
    orgPlaceholder: "使用你的用户请留空",
    create: "创建 GitHub App",
    createNew: "新建 GitHub App",
    remove: "移除已保存的应用",
    unreadable: "已保存的 GitHub App 无法读取。",
    envApp: "正在使用环境变量中的 GitHub App。",
    envTokenSaved: "正在使用环境变量中的 GITHUB_TOKEN。已保存的 GitHub App 不会在该变量存在时使用。",
    envToken: "正在使用环境变量中的 GITHUB_TOKEN。",
    savedApp: "正在使用本页保存的 GitHub App。",
    noApp: "还没有 GitHub App。",
    webhookEnv: "Webhook 密钥来自环境变量。",
    webhookMissing: "还没有 webhook 密钥。创建 GitHub App 时会存一个。",
    privateKeyEnv: "私钥来自环境变量。",
    privateKeySaved: "私钥已保存。",
    privateKeyMissing: "还没有私钥。",
    webhook: "Webhook 密钥",
    privateKey: "私钥",
  },
  review: {
    card: "审查",
    cardDescription: "基线分支没有覆盖时，使用这里的触发和草稿跳过。Diff 样式保存在这台浏览器。",
    postInformational: "发布说明性发现",
    postInformationalHelp: "除非基线分支设置 post_informational，说明性标注保持关闭。它们也不会要求修改。",
    postInformationalValue: "false",
    diff: "Diff 视图",
    diffHelp: "统一或分栏。保存在这台浏览器，不在服务器。",
    diffGroup: "Diff 视图",
    unified: "统一",
    split: "分栏",
    drafts: "跳过草稿拉取请求",
    fileDefaults: "仓库文件",
    fileDefaultsHelp: "这些 .dureview.md 键在基线分支未设置时使用下面的默认值。本页不保存它们。",
  },
  triggers: [
    { value: "manual", label: "手动" },
    { value: "once", label: "一次" },
    { value: "auto", label: "自动" },
  ],
  fileDefaults: [
    { key: "profile", value: "default", help: "quiet、default 或 loud。" },
    { key: "summary", value: "false", help: "为 true 时再发一条总结评论。" },
    { key: "language", value: "en", help: "发现正文用 en 或 zh。" },
    { key: "min_confidence", value: "0.5", help: "丢掉低于这个置信度的发现。" },
    { key: "min_inline_priority", value: "2", help: "仍会内联的最低优先级。0 表示只内联 P0。" },
    { key: "p2_inline_min_confidence", value: "0.7", help: "P2 要内联所需的置信度。" },
    { key: "max_inline", value: "10", help: "每次运行新增的内联评论上限。" },
  ],
  system: {
    runtime: "运行状态",
    runtimeHelp: "这个进程的只读信息。",
    version: "版本",
    versionHelp: "dureview 包版本。",
    uptime: "运行时间",
    uptimeHelp: "这个进程已经运行了多久。",
    dataDir: "数据目录",
    dataDirHelp: "凭证、审查和检出。用 DUREVIEW_DATA_DIR 设置。",
    running: "正在使用",
    runningHelp: "这个进程正在使用的提供方、模型和思考级别。",
    unavailable: "运行详情不可用。",
    sources: "设置来源",
    sourcesHelp: "先是页面覆盖，然后是环境变量，最后是内置默认值。",
    audit: "最近的更改",
    auditEmpty: "还没有更改。",
    when: "时间",
    who: "谁",
    setting: "设置",
    change: "更改",
  },
  fields: {
    provider: {
      label: "提供方",
      help: "新审查使用的提供方。未设置该变量时，优先用已保存的 Codex 登录，否则在设置了 OPENAI_API_KEY 时用 OpenAI。",
    },
    model: {
      label: "模型",
      help: "当前提供方在 pi-ai 目录中的模型 id。新审查使用这个模型。",
    },
    thinking: {
      label: "思考",
      help: "该模型的思考级别。审查会保持开始时的级别。",
    },
    defaultTrigger: {
      label: "默认触发",
      help: "基线分支没有 .dureview.md，或文件没有设置 trigger 时使用。",
    },
    skipDrafts: {
      label: "跳过草稿",
      help: "即使 .dureview.md 写了 drafts: true，也跳过草稿拉取请求。",
    },
    checkoutTtlDays: {
      label: "检出保留",
      help: "删除早于这么多天的检出。0 会删除没有审查在用的全部检出。下次清扫时生效。",
    },
    maxOutputTokens: {
      label: "单次输出上限",
      help: "一次模型回复最多使用的 token 数。每次模型调用都用这个上限。",
    },
  },
  sources: {
    override: "覆盖",
    env: "环境变量",
    default: "默认",
  },
  effective: {
    value: "当前值 {value}。",
    saved: "保存在本页。",
    env: "来自环境变量。",
    builtin: "内置默认值。",
    envIs: "环境变量是 {env}。",
    builtinIs: "内置默认值是 {builtin}。",
  },
  apiKeyText: {
    both: "已配置，末四位 {tail}。这个已保存的密钥会覆盖 {env}。",
    stored: "已配置，末四位 {tail}。",
    env: "由环境变量配置（{env}）。保存的密钥会覆盖它。",
    missing: "未配置。",
  },
  webhookSaved: "Webhook 密钥已保存，末四位 {tail}。",
  installed: "已安装在 {names}。",
  installedMore: "已安装在 {names}，另有 {extra} 个。",
  auditReset: "{previous} → 已重置",
  auditSet: "{previous} → {value}",
  auditOverride: "覆盖",
  auditUnset: "未设置",
  resetNamed: "重置{label}",
} satisfies SettingsCopy;

export function settingsCatalog(locale: Locale): SettingsCopy {
  return locale === "zh-CN" ? settingsCopyZh : settingsCopy;
}

export function sectionDocumentTitle(section: SettingsSection, locale: Locale = "en"): string {
  const copy = settingsCatalog(locale);
  return `${copy.section[section]} · ${copy.documentTitle}`;
}

export function fieldCopy(field: SettingsFieldView, copy: SettingsCopy): { label: string; help: string } {
  if (isCatalogField(field.key, copy.fields)) return copy.fields[field.key];
  return { label: field.label, help: field.help };
}

function isCatalogField(key: string, fields: SettingsCopy["fields"]): key is keyof SettingsCopy["fields"] {
  return Object.prototype.hasOwnProperty.call(fields, key);
}

export function sourceSentence(field: SettingsFieldView, copy: SettingsCopy = settingsCopy): string {
  const where = field.source === "override" ? copy.effective.saved : field.source === "env" ? copy.effective.env : copy.effective.builtin;
  const parts = [fill(copy.effective.value, { value: field.value }), where];
  if (field.env !== null && field.source !== "env") parts.push(fill(copy.effective.envIs, { env: field.env }));
  if (field.source !== "default") parts.push(fill(copy.effective.builtinIs, { builtin: field.builtin }));
  return parts.join(" ");
}

export function apiKeySentence(row: ApiKeyView, copy: SettingsCopy = settingsCopy): string {
  if (row.stored && row.tail && row.fromEnv) return fill(copy.apiKeyText.both, { tail: row.tail, env: row.envName });
  if (row.stored && row.tail) return fill(copy.apiKeyText.stored, { tail: row.tail });
  if (row.fromEnv) return fill(copy.apiKeyText.env, { env: row.envName });
  return copy.apiKeyText.missing;
}

export function githubSentence(github: GitHubSetupView, copy: SettingsCopy = settingsCopy): string {
  if (github.kind === "environment-app") return copy.github.envApp;
  if (github.kind === "environment-token") return github.saved ? copy.github.envTokenSaved : copy.github.envToken;
  if (github.kind === "saved") return copy.github.savedApp;
  return copy.github.noApp;
}

export function webhookSentence(github: GitHubSetupView, copy: SettingsCopy = settingsCopy): string {
  if (github.webhook === "environment") return copy.github.webhookEnv;
  if (github.webhook === "saved" && github.webhookTail) return fill(copy.webhookSaved, { tail: github.webhookTail });
  return copy.github.webhookMissing;
}

export function privateKeySentence(github: GitHubSetupView, copy: SettingsCopy = settingsCopy): string {
  if (github.privateKey === "environment") return copy.github.privateKeyEnv;
  if (github.privateKey === "saved") return copy.github.privateKeySaved;
  return copy.github.privateKeyMissing;
}

export function installationsSentence(names: string[], extra: number, copy: SettingsCopy = settingsCopy): string {
  const listed = names.join(", ");
  return extra > 0 ? fill(copy.installedMore, { names: listed, extra }) : fill(copy.installed, { names: listed });
}

export function resetToSentence(previous: string | null, value: string | null, action: "set" | "reset", copy: SettingsCopy = settingsCopy): string {
  if (action === "reset") return fill(copy.auditReset, { previous: previous ?? copy.auditOverride });
  return fill(copy.auditSet, { previous: previous ?? copy.auditUnset, value: value ?? "" });
}

export function resetLabel(label: string, copy: SettingsCopy = settingsCopy): string {
  return fill(copy.resetNamed, { label });
}
