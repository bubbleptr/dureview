import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import { isProviderName, providerLabel } from "../auth/providers.js";
import type { EditableBaseline } from "../config.js";
import type { ReviewTrigger } from "../review/policy.js";
import {
  emptyConsole,
  SOURCE_LABEL,
  type ConsoleView,
  type ProviderCatalog,
  type SettingsAuditView,
  type SettingsFieldView,
  type SettingsFormValues,
  type SettingsPageModel,
} from "./page.js";
import {
  encodeSetting,
  isSettingKey,
  parseModelId,
  parseSettingValue,
  parseThinkingSetting,
  parseTriggerSetting,
  parseTtlDaysSetting,
  resolveSettings,
  type ResolvedField,
  type ResolvedSettings,
  type SettingKey,
} from "./resolve.js";
import { SettingsStore, type SettingsAuditRow } from "./store.js";
import { modelChoiceError, thinkingLevelsFor } from "./validate.js";

export type EffectiveConfig = {
  provider: string;
  modelId: string;
  thinking: ModelThinkingLevel;
  defaultTrigger: ReviewTrigger;
  skipDrafts: boolean;
  checkoutTtlDays: number;
};

export type SettingsWriteResult = { ok: true } | { ok: false; error: string };

const FIELD_META: Record<SettingKey, { label: string; envName: string; help: string }> = {
  provider: {
    label: "Provider",
    envName: "DUREVIEW_PROVIDER",
    help: "Provider for new reviews. When this variable is unset, a stored Codex login is used, otherwise OpenAI when OPENAI_API_KEY is set.",
  },
  model: {
    label: "Model",
    envName: "DUREVIEW_MODEL",
    help: "Model id from the pi-ai catalog for the active provider. New reviews use this model.",
  },
  thinking: {
    label: "Thinking",
    envName: "DUREVIEW_THINKING",
    help: "Thinking level for that model. A review keeps the level it started with.",
  },
  defaultTrigger: {
    label: "Default trigger",
    envName: "DUREVIEW_DEFAULT_TRIGGER",
    help: "Used when the base branch has no .dureview.md, or the file does not set trigger.",
  },
  skipDrafts: {
    label: "Skip drafts",
    envName: "DUREVIEW_SKIP_DRAFTS",
    help: "Skip draft pull requests even when .dureview.md sets drafts: true.",
  },
  checkoutTtlDays: {
    label: "Checkout TTL",
    envName: "DUREVIEW_CHECKOUT_TTL_DAYS",
    help: "Delete checkouts older than this many days. 0 deletes every checkout no review is using. The next sweep picks this up.",
  },
};

/**
 * Runtime configuration: a settings-page override, else the environment, else the built-in default.
 * The override map is cached in memory and replaced only after a successful write.
 */
export class ServerSettings {
  #overrides = new Map<string, string>();
  #chain: Promise<unknown> = Promise.resolve();
  #fallbackProvider: string;

  private constructor(
    private readonly store: SettingsStore,
    private readonly baseline: EditableBaseline,
    private readonly models: Models,
    fallbackProvider: string,
  ) {
    this.#fallbackProvider = fallbackProvider;
  }

  static async open(options: {
    file: string;
    baseline: EditableBaseline;
    models: Models;
    provider: string;
  }): Promise<ServerSettings> {
    const store = await SettingsStore.open(options.file);
    const settings = new ServerSettings(store, options.baseline, options.models, options.provider);
    settings.#overrides = await store.readAll();
    return settings;
  }

  close(): void {
    this.store.close();
  }

  setFallbackProvider(provider: string): void {
    this.#fallbackProvider = provider;
  }

  effective(): EffectiveConfig {
    const resolved = this.#resolved();
    return {
      provider: resolved.provider.value,
      modelId: resolved.model.value,
      thinking: resolved.thinking.value,
      defaultTrigger: resolved.defaultTrigger.value,
      skipDrafts: resolved.skipDrafts.value,
      checkoutTtlDays: resolved.checkoutTtlDays.value,
    };
  }

  async page(extra: { error?: string | null; saved?: boolean; notice?: string | null; console?: ConsoleView } = {}): Promise<SettingsPageModel> {
    const resolved = this.#resolved();
    const problems = storedProblems(this.#overrides);
    const catalogs = this.#catalogs(resolved.provider.value);
    const active = catalogs.find((catalog) => catalog.provider === resolved.provider.value);
    const modelOptions = active ? active.models.map((model) => model.id) : this.#modelOptions(resolved.provider.value, resolved.model.value);
    if (!modelOptions.includes(resolved.model.value)) modelOptions.push(resolved.model.value);
    const thinkingByModel: Record<string, string[]> = {};
    for (const model of active?.models ?? []) thinkingByModel[model.id] = model.thinking;
    const audit = (await this.store.audit(20)).map(auditView);
    const form: SettingsFormValues = {
      provider: resolved.provider.value,
      model: resolved.model.value,
      thinking: resolved.thinking.value,
      defaultTrigger: resolved.defaultTrigger.value,
      skipDrafts: resolved.skipDrafts.value,
      checkoutTtlDays: String(resolved.checkoutTtlDays.value),
    };
    return {
      provider: resolved.provider.value,
      modelOptions: [...new Set(modelOptions)].sort((left, right) => left.localeCompare(right)),
      thinkingByModel,
      catalogs,
      fields: {
        provider: fieldView("provider", resolved.provider, resolved.provider.value),
        model: fieldView("model", resolved.model, String(resolved.model.value)),
        thinking: fieldView("thinking", resolved.thinking, resolved.thinking.value),
        defaultTrigger: fieldView("defaultTrigger", resolved.defaultTrigger, resolved.defaultTrigger.value),
        skipDrafts: fieldView("skipDrafts", resolved.skipDrafts, resolved.skipDrafts.value ? "true" : "false"),
        checkoutTtlDays: fieldView("checkoutTtlDays", resolved.checkoutTtlDays, String(resolved.checkoutTtlDays.value)),
      },
      form,
      console: extra.console ?? emptyConsole(),
      problems,
      audit,
      error: extra.error ?? null,
      notice: extra.notice ?? null,
      saved: extra.saved === true,
      csrf: "",
    };
  }

  /** A section posts only the fields it shows. Anything left out stays as it is. */
  save(input: Partial<SettingsFormValues>, actor: string): Promise<SettingsWriteResult> {
    return this.#exclusive(() => {
      const parsed = parseForm(input, this.models, this.#resolved().provider.value);
      if (!parsed.ok) return parsed;
      const next = new Map(this.#overrides);
      applyParsed(next, parsed.value, this.baseline, this.#fallbackProvider);
      const error = this.#choiceError(next);
      if (error) return { ok: false, error };
      return this.#commit(next, actor).then(() => ({ ok: true as const }));
    });
  }

  reset(key: string, actor: string): Promise<SettingsWriteResult> {
    return this.#exclusive(() => {
      if (!isSettingKey(key)) return { ok: false, error: "Unknown setting." };
      if (!this.#overrides.has(key)) return { ok: true };
      const next = new Map(this.#overrides);
      next.delete(key);
      const error = this.#choiceError(next);
      if (error) {
        return {
          ok: false,
          error: `Resetting ${FIELD_META[key].label.toLowerCase()} leaves a model and thinking level that do not match. Change them together, then save.`,
        };
      }
      return this.#commit(next, actor).then(() => ({ ok: true as const }));
    });
  }

  #exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #commit(next: Map<string, string>, actor: string): Promise<void> {
    const previous = this.#overrides;
    await this.store.writeDiff(previous, next, actor);
    this.#overrides = next;
  }

  #resolved(): ResolvedSettings {
    return resolveSettings(this.#overrides, this.baseline, this.#fallbackProvider);
  }

  #choiceError(raw: ReadonlyMap<string, string>): string | null {
    const resolved = resolveSettings(raw, this.baseline, this.#fallbackProvider);
    return modelChoiceError(this.models, resolved.provider.value, resolved.model.value, resolved.thinking.value);
  }

  #modelOptions(provider: string, current: string): string[] {
    const ids = this.models
      .getModels(provider)
      .map((model) => model.id)
      .filter((id) => parseModelId(id) !== undefined);
    if (parseModelId(current) && !ids.includes(current)) ids.push(current);
    return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  }

  #catalogs(current: string): ProviderCatalog[] {
    const providers = new Set<string>([current]);
    for (const id of ["openai-codex", "github-copilot", "xai", "openai", "openrouter", "deepseek"] as const) {
      if (this.models.getModels(id).some((model) => parseModelId(model.id) !== undefined)) providers.add(id);
    }
    return [...providers].map((provider) => ({
      provider,
      label: providerLabel(provider),
      models: this.#modelOptions(provider, provider === current ? this.#resolved().model.value : "").map((id) => ({
        id,
        thinking: thinkingLevelsFor(this.models, provider, id),
      })),
    }));
  }
}

type ParsedSettings = {
  provider?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
  defaultTrigger?: ReviewTrigger;
  skipDrafts?: boolean;
  checkoutTtlDays?: number;
};

function applyParsed(next: Map<string, string>, values: ParsedSettings, baseline: EditableBaseline, fallbackProvider: string): void {
  if (values.provider !== undefined) putOrClear(next, "provider", values.provider, baseline.provider, fallbackProvider);
  if (values.model !== undefined) putOrClear(next, "model", values.model, baseline.modelId, fallbackProvider);
  if (values.thinking !== undefined) putOrClear(next, "thinking", values.thinking, baseline.thinking, fallbackProvider);
  if (values.defaultTrigger !== undefined) putOrClear(next, "defaultTrigger", values.defaultTrigger, baseline.defaultTrigger, fallbackProvider);
  if (values.skipDrafts !== undefined) putOrClear(next, "skipDrafts", values.skipDrafts, baseline.skipDrafts, fallbackProvider);
  if (values.checkoutTtlDays !== undefined) putOrClear(next, "checkoutTtlDays", values.checkoutTtlDays, baseline.checkoutTtlDays, fallbackProvider);
}

function putOrClear<T extends string | ModelThinkingLevel | ReviewTrigger | boolean | number>(
  next: Map<string, string>,
  key: SettingKey,
  value: T,
  env: T | undefined,
  fallbackProvider: string,
): void {
  const builtin = resolveSettings(
    new Map(),
    {
      modelId: undefined,
      thinking: undefined,
      defaultTrigger: undefined,
      skipDrafts: undefined,
      checkoutTtlDays: undefined,
      provider: undefined,
    },
    fallbackProvider,
  );
  const fallback = env !== undefined ? env : builtinValue(key, builtin);
  if (sameValue(value, fallback)) {
    next.delete(key);
    return;
  }
  next.set(key, encodeSetting(key, value));
}

function builtinValue(key: SettingKey, resolved: ResolvedSettings): string | ModelThinkingLevel | ReviewTrigger | boolean | number {
  if (key === "provider") return resolved.provider.builtin;
  if (key === "model") return resolved.model.builtin;
  if (key === "thinking") return resolved.thinking.builtin;
  if (key === "defaultTrigger") return resolved.defaultTrigger.builtin;
  if (key === "skipDrafts") return resolved.skipDrafts.builtin;
  return resolved.checkoutTtlDays.builtin;
}

function acceptProvider(value: string, models: Models, current: string): string | undefined {
  if (value === current) return value;
  if (!isProviderName(value)) return undefined;
  if (!models.getModels(value).some((model) => parseModelId(model.id) !== undefined)) return undefined;
  return value;
}

function sameValue(left: string | boolean | number, right: string | boolean | number): boolean {
  return left === right;
}

function parseForm(
  input: Partial<SettingsFormValues>,
  models: Models,
  currentProvider: string,
): { ok: false; error: string } | { ok: true; value: ParsedSettings } {
  const value: ParsedSettings = {};
  if (input.provider !== undefined) {
    const requested = input.provider.trim();
    if (requested !== "") {
      const accepted = acceptProvider(requested, models, currentProvider);
      if (!accepted) return { ok: false, error: "Provider is not one this server can use." };
      value.provider = accepted;
    }
  }
  if (input.model !== undefined) {
    const model = parseModelId(input.model);
    if (model === undefined) return { ok: false, error: "Model id is empty or not a catalog id." };
    value.model = model;
  }
  if (input.thinking !== undefined) {
    const thinking = parseThinkingSetting(input.thinking);
    if (thinking === undefined) return { ok: false, error: "Thinking level is not a known level." };
    value.thinking = thinking;
  }
  if (input.defaultTrigger !== undefined) {
    const defaultTrigger = parseTriggerSetting(input.defaultTrigger);
    if (defaultTrigger === undefined) return { ok: false, error: "Default trigger must be auto, once, or manual." };
    value.defaultTrigger = defaultTrigger;
  }
  if (input.checkoutTtlDays !== undefined) {
    const checkoutTtlDays = parseTtlDaysSetting(input.checkoutTtlDays);
    if (checkoutTtlDays === undefined) {
      return { ok: false, error: "Checkout TTL must be a non-negative integer number of days." };
    }
    value.checkoutTtlDays = checkoutTtlDays;
  }
  if (input.skipDrafts !== undefined) value.skipDrafts = input.skipDrafts;
  return { ok: true, value };
}

function storedProblems(raw: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, value] of raw) {
    if (!isSettingKey(key)) {
      problems.push(`Ignored unknown setting ${key}.`);
      continue;
    }
    if (parseSettingValue(key, value) === undefined) {
      problems.push(`Stored override for ${FIELD_META[key].label.toLowerCase()} is invalid and is not applied. Reset it.`);
    }
  }
  return problems;
}

function fieldView<T extends string | boolean | number>(key: SettingKey, field: ResolvedField<T>, value: string): SettingsFieldView {
  const meta = FIELD_META[key];
  return {
    key,
    label: meta.label,
    envName: meta.envName,
    value,
    source: field.source,
    sourceLabel: SOURCE_LABEL[field.source],
    builtin: String(field.builtin),
    env: field.env === null ? null : String(field.env),
    canReset: field.stored,
    help: meta.help,
  };
}

function auditView(row: SettingsAuditRow): SettingsAuditView {
  return {
    key: row.key,
    action: row.action,
    previous: row.previous,
    value: row.value,
    actor: row.actor,
    at: row.at,
  };
}
