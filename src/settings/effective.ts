import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import type { EditableBaseline } from "../config.js";
import type { ReviewTrigger } from "../review/policy.js";
import { SOURCE_LABEL, type SettingsAuditView, type SettingsFieldView, type SettingsFormValues, type SettingsPageModel } from "./page.js";
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

  private constructor(
    private readonly store: SettingsStore,
    private readonly baseline: EditableBaseline,
    private readonly models: Models,
    readonly provider: string,
  ) {}

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

  effective(): EffectiveConfig {
    const resolved = this.#resolved();
    return {
      provider: this.provider,
      modelId: resolved.model.value,
      thinking: resolved.thinking.value,
      defaultTrigger: resolved.defaultTrigger.value,
      skipDrafts: resolved.skipDrafts.value,
      checkoutTtlDays: resolved.checkoutTtlDays.value,
    };
  }

  async page(extra: { error?: string | null; saved?: boolean } = {}): Promise<SettingsPageModel> {
    const resolved = this.#resolved();
    const problems = storedProblems(this.#overrides);
    const modelOptions = this.#modelOptions(resolved.model.value);
    const thinkingByModel: Record<string, string[]> = {};
    for (const id of modelOptions) {
      thinkingByModel[id] = thinkingLevelsFor(this.models, this.provider, id);
    }
    const audit = (await this.store.audit(20)).map(auditView);
    const form: SettingsFormValues = {
      model: resolved.model.value,
      thinking: resolved.thinking.value,
      defaultTrigger: resolved.defaultTrigger.value,
      skipDrafts: resolved.skipDrafts.value,
      checkoutTtlDays: String(resolved.checkoutTtlDays.value),
    };
    return {
      provider: this.provider,
      modelOptions,
      thinkingByModel,
      fields: {
        model: fieldView("model", resolved.model, String(resolved.model.value)),
        thinking: fieldView("thinking", resolved.thinking, resolved.thinking.value),
        defaultTrigger: fieldView("defaultTrigger", resolved.defaultTrigger, resolved.defaultTrigger.value),
        skipDrafts: fieldView("skipDrafts", resolved.skipDrafts, resolved.skipDrafts.value ? "true" : "false"),
        checkoutTtlDays: fieldView("checkoutTtlDays", resolved.checkoutTtlDays, String(resolved.checkoutTtlDays.value)),
      },
      form,
      problems,
      audit,
      error: extra.error ?? null,
      saved: extra.saved === true,
    };
  }

  save(input: SettingsFormValues, actor: string): Promise<SettingsWriteResult> {
    return this.#exclusive(() => {
      const parsed = parseForm(input);
      if (!parsed.ok) return parsed;
      const next = new Map(this.#overrides);
      applyParsed(next, parsed.value, this.baseline);
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
    return resolveSettings(this.#overrides, this.baseline);
  }

  #choiceError(raw: ReadonlyMap<string, string>): string | null {
    const resolved = resolveSettings(raw, this.baseline);
    return modelChoiceError(this.models, this.provider, resolved.model.value, resolved.thinking.value);
  }

  #modelOptions(current: string): string[] {
    const ids = this.models
      .getModels(this.provider)
      .map((model) => model.id)
      .filter((id) => id.length > 0);
    if (!ids.includes(current)) ids.push(current);
    return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
  }
}

function applyParsed(
  next: Map<string, string>,
  values: {
    model: string;
    thinking: ModelThinkingLevel;
    defaultTrigger: ReviewTrigger;
    skipDrafts: boolean;
    checkoutTtlDays: number;
  },
  baseline: EditableBaseline,
): void {
  putOrClear(next, "model", values.model, baseline.modelId);
  putOrClear(next, "thinking", values.thinking, baseline.thinking);
  putOrClear(next, "defaultTrigger", values.defaultTrigger, baseline.defaultTrigger);
  putOrClear(next, "skipDrafts", values.skipDrafts, baseline.skipDrafts);
  putOrClear(next, "checkoutTtlDays", values.checkoutTtlDays, baseline.checkoutTtlDays);
}

function putOrClear<T extends string | ModelThinkingLevel | ReviewTrigger | boolean | number>(
  next: Map<string, string>,
  key: SettingKey,
  value: T,
  env: T | undefined,
): void {
  const builtin = resolveSettings(new Map(), {
    modelId: undefined,
    thinking: undefined,
    defaultTrigger: undefined,
    skipDrafts: undefined,
    checkoutTtlDays: undefined,
  });
  const fallback = env !== undefined ? env : builtinValue(key, builtin);
  if (sameValue(value, fallback)) {
    next.delete(key);
    return;
  }
  next.set(key, encodeSetting(key, value));
}

function builtinValue(key: SettingKey, resolved: ResolvedSettings): string | ModelThinkingLevel | ReviewTrigger | boolean | number {
  if (key === "model") return resolved.model.builtin;
  if (key === "thinking") return resolved.thinking.builtin;
  if (key === "defaultTrigger") return resolved.defaultTrigger.builtin;
  if (key === "skipDrafts") return resolved.skipDrafts.builtin;
  return resolved.checkoutTtlDays.builtin;
}

function sameValue(left: string | boolean | number, right: string | boolean | number): boolean {
  return left === right;
}

function parseForm(input: SettingsFormValues):
  | { ok: false; error: string }
  | {
      ok: true;
      value: {
        model: string;
        thinking: ModelThinkingLevel;
        defaultTrigger: ReviewTrigger;
        skipDrafts: boolean;
        checkoutTtlDays: number;
      };
    } {
  const model = parseModelId(input.model);
  const thinking = parseThinkingSetting(input.thinking);
  const defaultTrigger = parseTriggerSetting(input.defaultTrigger);
  const checkoutTtlDays = parseTtlDaysSetting(input.checkoutTtlDays);
  if (model === undefined) return { ok: false, error: "Model id is empty or not a catalog id." };
  if (thinking === undefined) return { ok: false, error: "Thinking level is not a known level." };
  if (defaultTrigger === undefined) return { ok: false, error: "Default trigger must be auto, once, or manual." };
  if (checkoutTtlDays === undefined) {
    return { ok: false, error: "Checkout TTL must be a non-negative integer number of days." };
  }
  return {
    ok: true,
    value: {
      model,
      thinking,
      defaultTrigger,
      skipDrafts: input.skipDrafts,
      checkoutTtlDays,
    },
  };
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
