import { useState } from "react";
import type { ProviderCatalog, SettingsFieldView, SettingsPageModel } from "../settings/page.js";
import { nearestThinking } from "../settings/thinking.js";
import { useI18n, useSettingsCopy } from "../ui/i18n.js";
import { localizeKnown } from "../ui/messages.js";
import { formatTime } from "../ui/page.js";
import { fieldCopy, resetLabel, resetToSentence, sourceSentence } from "../ui/settings-copy.js";
import { isSettingsSection, SETTINGS_SECTIONS, settingsSectionHref, type SettingsSection } from "../ui/settings-sections.js";
import type { ShellStatus } from "../ui/shell-status.js";
import { LocalTime } from "./local-time.js";
import { AppShell } from "./app-shell.js";
import { DiffStyleControl } from "./diff-style.js";
import { ApiKeys, GitHubSetup, Subscriptions } from "./settings-connections.js";
import { SettingRow, SettingsCard } from "./settings-row.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { FormSelect } from "./ui/form-select.js";
import { Input } from "./ui/input.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

export type SettingsRouteData =
  | { kind: "login"; next: string; status: null }
  | { kind: "page"; model: SettingsPageModel; section: SettingsSection; status: ShellStatus | null };

export function SettingsForm({
  model,
  status = null,
  section,
}: {
  model: SettingsPageModel;
  status?: ShellStatus | null;
  section: SettingsSection;
}) {
  const settingsCopy = useSettingsCopy();
  return (
    <AppShell current="settings" title={settingsCopy.title}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 md:flex-row md:items-start md:gap-12">
        <SettingsNav section={section} />
        <div data-section={section} className="flex min-w-0 flex-1 flex-col gap-6">
          <header className="flex flex-col gap-1">
            <h2 className="text-lg font-medium tracking-tight">{settingsCopy.section[section]}</h2>
            <p className="max-w-prose text-sm leading-5 text-muted-foreground">{settingsCopy.lead[section]}</p>
          </header>
          <Banners model={model} />
          <SectionBody model={model} status={status} section={section} />
        </div>
      </div>
    </AppShell>
  );
}

function SettingsNav({ section }: { section: SettingsSection }) {
  const settingsCopy = useSettingsCopy();
  const options = SETTINGS_SECTIONS.map((id) => ({ value: id, label: settingsCopy.section[id] }));
  return (
    <div className="md:sticky md:top-0 md:w-52 md:shrink-0">
      <div className="flex flex-col gap-1.5 md:hidden">
        <label htmlFor="settings-section" className="text-xs font-medium text-muted-foreground">
          {settingsCopy.sectionLabel}
        </label>
        <FormSelect
          id="settings-section"
          name="settingsSection"
          value={section}
          options={options}
          variant="select"
          onValueChange={(next) => {
            if (isSettingsSection(next)) window.location.assign(settingsSectionHref(next));
          }}
        />
      </div>
      <nav className="hidden flex-col gap-0.5 md:flex" aria-label={settingsCopy.sectionsLabel}>
        {SETTINGS_SECTIONS.map((id) => {
          const on = id === section;
          return (
            <a
              key={id}
              href={settingsSectionHref(id)}
              aria-current={on ? "page" : undefined}
              className={
                on
                  ? "flex h-8 items-center rounded-md bg-accent px-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  : "flex h-8 items-center rounded-md px-2 text-sm text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              }
            >
              {settingsCopy.section[id]}
            </a>
          );
        })}
      </nav>
    </div>
  );
}

function Banners({ model }: { model: SettingsPageModel }) {
  const { locale } = useI18n();
  const settingsCopy = useSettingsCopy();
  return (
    <>
      {model.error ? (
        <p className="text-sm text-destructive" role="alert">
          {localizeKnown(locale, model.error)}
        </p>
      ) : null}
      {model.notice ? <p className="text-sm">{localizeKnown(locale, model.notice)}</p> : null}
      {model.saved ? <p className="text-sm">{settingsCopy.banners.saved}</p> : null}
      {model.problems.map((problem) => (
        <p key={problem} className="text-sm text-destructive" role="alert">
          {localizeKnown(locale, problem)}
        </p>
      ))}
    </>
  );
}

function SectionBody({
  model,
  status,
  section,
}: {
  model: SettingsPageModel;
  status: ShellStatus | null;
  section: SettingsSection;
}) {
  switch (section) {
    case "models":
      return <ModelsSection model={model} status={status} section={section} />;
    case "github":
      return <GitHubSetup github={model.console.github} csrf={model.csrf} status={status} section={section} />;
    case "review":
      return <ReviewSection model={model} section={section} />;
    case "system":
      return <SystemSection model={model} status={status} />;
    default: {
      const _exhaustive: never = section;
      return _exhaustive;
    }
  }
}

function ModelsSection({
  model,
  status,
  section,
}: {
  model: SettingsPageModel;
  status: ShellStatus | null;
  section: SettingsSection;
}) {
  const settingsCopy = useSettingsCopy();
  const [provider, setProvider] = useState(model.form.provider || model.provider);
  const [modelId, setModelId] = useState(model.form.model);
  const [thinking, setThinking] = useState<string>(model.form.thinking);
  const options = modelIds(model, provider, modelId);
  const levels = levelsFor(model, provider, modelId, thinking);
  const thinkingValue = levels.includes(thinking) ? thinking : (levels[0] ?? thinking);
  return (
    <div className="flex flex-col gap-8">
      <form method="post" action="/ui/settings">
        <CsrfField token={model.csrf} />
        <SectionField section={section} />
        <SettingsCard title={settingsCopy.modelCard.title} description={settingsCopy.modelCard.description}>
          <ProviderField
            field={model.fields.provider}
            catalogs={model.catalogs}
            value={provider}
            onChange={(next) => {
              const nextModels = modelIds(model, next, "");
              const nextModel = nextModels.includes(modelId) ? modelId : (nextModels[0] ?? modelId);
              setProvider(next);
              setModelId(nextModel);
              setThinking(nearestThinking(levelsFor(model, next, nextModel, thinking), thinking));
            }}
          />
          <ModelField
            field={model.fields.model}
            options={options}
            value={modelId}
            onChange={(next) => {
              setModelId(next);
              setThinking(nearestThinking(levelsFor(model, provider, next, thinking), thinking));
            }}
          />
          <ThinkingField field={model.fields.thinking} levels={levels} value={thinkingValue} onChange={setThinking} />
          <div className="flex justify-end py-5">
            <Button type="submit" name="save" value="1">
              {settingsCopy.save}
            </Button>
          </div>
        </SettingsCard>
      </form>
      <Subscriptions rows={model.console.subscriptions} logins={model.console.logins} csrf={model.csrf} status={status} section={section} />
      <ApiKeys rows={model.console.apiKeys} csrf={model.csrf} section={section} />
    </div>
  );
}

function ReviewSection({ model, section }: { model: SettingsPageModel; section: SettingsSection }) {
  const settingsCopy = useSettingsCopy();
  const copy = settingsCopy.review;
  return (
    <form className="flex flex-col gap-8" method="post" action="/ui/settings">
      <CsrfField token={model.csrf} />
      <SectionField section={section} />
      <SettingsCard title={copy.card} description={copy.cardDescription}>
        <TriggerField field={model.fields.defaultTrigger} value={model.form.defaultTrigger} />
        <SkipDraftsField field={model.fields.skipDrafts} checked={model.form.skipDrafts} />
        <SettingRow title={copy.postInformational} description={copy.postInformationalHelp}>
          <span className="font-mono text-sm">{copy.postInformationalValue}</span>
        </SettingRow>
        <SettingRow title={copy.diff} description={copy.diffHelp}>
          <DiffStyleControl />
        </SettingRow>
        <div className="flex justify-end py-5">
          <Button type="submit" name="save" value="1">
            {settingsCopy.save}
          </Button>
        </div>
      </SettingsCard>
      <details className="rounded-lg border bg-card">
        <summary className="cursor-pointer px-5 py-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {settingsCopy.advanced}
        </summary>
        <div className="border-t px-5">
          <TtlField field={model.fields.checkoutTtlDays} value={model.form.checkoutTtlDays} />
          <div className="flex flex-col gap-1 py-5">
            <p className="text-sm font-medium">{copy.fileDefaults}</p>
            <p className="max-w-prose text-sm leading-5 text-muted-foreground">{copy.fileDefaultsHelp}</p>
          </div>
          {settingsCopy.fileDefaults.map((row) => (
            <SettingRow key={row.key} title={row.key} monoTitle description={row.help}>
              <span className="font-mono text-sm">{row.value}</span>
            </SettingRow>
          ))}
        </div>
      </details>
    </form>
  );
}

function SystemSection({ model, status }: { model: SettingsPageModel; status: ShellStatus | null }) {
  const settingsCopy = useSettingsCopy();
  const copy = settingsCopy.system;
  const fields = [
    model.fields.provider,
    model.fields.model,
    model.fields.thinking,
    model.fields.defaultTrigger,
    model.fields.skipDrafts,
    model.fields.checkoutTtlDays,
  ];
  return (
    <div className="flex flex-col gap-8">
      <SettingsCard title={copy.runtime} description={copy.runtimeHelp}>
        {status ? (
          <>
            <SettingRow title={copy.version} description={copy.versionHelp}>
              <span className="font-mono text-sm">{status.version}</span>
            </SettingRow>
            <SettingRow title={copy.uptime} description={copy.uptimeHelp}>
              <span className="text-sm">{status.uptime}</span>
            </SettingRow>
            <SettingRow title={copy.dataDir} description={copy.dataDirHelp}>
              <span className="block w-full min-w-0 text-right font-mono text-sm break-all">{status.dataDir ?? settingsCopy.notSet}</span>
            </SettingRow>
            <SettingRow title={copy.running} description={copy.runningHelp}>
              <p className="text-sm">
                {status.provider}/<span className="font-mono">{status.model}</span>
                {" · "}
                {status.thinking}
              </p>
            </SettingRow>
          </>
        ) : (
          <p className="py-5 text-sm text-muted-foreground">{copy.unavailable}</p>
        )}
      </SettingsCard>
      <SettingsCard title={copy.sources} description={copy.sourcesHelp}>
        {fields.map((field) => (
          <SettingRow
            key={field.key}
            title={fieldCopy(field, settingsCopy).label}
            description={
              <>
                <span className="font-mono">{field.envName}</span>
                {". "}
                {sourceSentence(field, settingsCopy)}
              </>
            }
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Badge variant="outline">{settingsCopy.sources[field.source]}</Badge>
              {field.canReset ? (
                <Button
                  type="submit"
                  name="reset"
                  value={field.key}
                  variant="outline"
                  size="sm"
                  form="settings-reset"
                  aria-label={resetLabel(fieldCopy(field, settingsCopy).label, settingsCopy)}
                >
                  {settingsCopy.reset}
                </Button>
              ) : null}
            </div>
          </SettingRow>
        ))}
      </SettingsCard>
      <SettingsCard title={copy.audit}>
        {model.audit.length === 0 ? <p className="py-5 text-sm text-muted-foreground">{copy.auditEmpty}</p> : <AuditTable audit={model.audit} />}
      </SettingsCard>
      <form id="settings-reset" method="post" action="/ui/settings">
        <CsrfField token={model.csrf} />
        <SectionField section="system" />
      </form>
    </div>
  );
}

function AuditTable({ audit }: { audit: SettingsPageModel["audit"] }) {
  const { locale } = useI18n();
  const settingsCopy = useSettingsCopy();
  const copy = settingsCopy.system;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{copy.when}</TableHead>
          <TableHead>{copy.who}</TableHead>
          <TableHead>{copy.setting}</TableHead>
          <TableHead>{copy.change}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {audit.map((row, index) => (
          <TableRow key={`${row.at}-${row.key}-${index}`}>
            <TableCell className="text-muted-foreground">
              <LocalTime iso={row.at} label={formatTime(row.at, locale)} />
            </TableCell>
            <TableCell>{row.actor}</TableCell>
            <TableCell>{row.key}</TableCell>
            <TableCell>{resetToSentence(row.previous, row.value, row.action, settingsCopy)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ProviderField({
  field,
  catalogs,
  value,
  onChange,
}: {
  field: SettingsFieldView;
  catalogs: ProviderCatalog[];
  value: string;
  onChange: (value: string) => void;
}) {
  const text = fieldCopy(field, useSettingsCopy());
  const listed = catalogs.some((catalog) => catalog.provider === value)
    ? catalogs
    : [{ provider: value, label: value, models: [] }, ...catalogs];
  return (
    <SettingRow title={text.label} description={text.help} htmlFor={field.key}>
      <div className="w-full">
        <FormSelect
          id={field.key}
          name="provider"
          value={value}
          options={listed.map((catalog) => ({ value: catalog.provider, label: catalog.label }))}
          onValueChange={onChange}
          variant="select"
        />
      </div>
    </SettingRow>
  );
}

function ModelField({
  field,
  options,
  value,
  onChange,
}: {
  field: SettingsFieldView;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const text = fieldCopy(field, useSettingsCopy());
  const choices = options.includes(value) ? options : [value, ...options];
  return (
    <SettingRow title={text.label} description={text.help} htmlFor={field.key}>
      <div className="w-full">
        <FormSelect
          id={field.key}
          name="model"
          value={value}
          options={choices.map((id) => ({ value: id, label: id }))}
          onValueChange={onChange}
          variant="combobox"
          className="font-mono"
        />
      </div>
    </SettingRow>
  );
}

function ThinkingField({
  field,
  levels,
  value,
  onChange,
}: {
  field: SettingsFieldView;
  levels: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const text = fieldCopy(field, useSettingsCopy());
  const choices = levels.includes(value) ? levels : [value, ...levels];
  return (
    <SettingRow title={text.label} description={text.help} htmlFor={field.key}>
      <div className="w-full">
        <FormSelect
          id={field.key}
          name="thinking"
          value={value}
          options={choices.map((level) => ({ value: level, label: level }))}
          onValueChange={onChange}
        />
      </div>
    </SettingRow>
  );
}

function TriggerField({ field, value }: { field: SettingsFieldView; value: string }) {
  const settingsCopy = useSettingsCopy();
  const text = fieldCopy(field, settingsCopy);
  return (
    <SettingRow title={text.label} description={text.help} htmlFor={field.key}>
      <div className="w-full">
        <FormSelect id={field.key} name="defaultTrigger" defaultValue={value} options={[...settingsCopy.triggers]} />
      </div>
    </SettingRow>
  );
}

function SkipDraftsField({ field, checked }: { field: SettingsFieldView; checked: boolean }) {
  const text = fieldCopy(field, useSettingsCopy());
  return (
    <SettingRow title={text.label} description={text.help} htmlFor={field.key}>
      <input type="hidden" name="skipDrafts" value="false" />
      <input id={field.key} className="size-4 accent-foreground" type="checkbox" name="skipDrafts" value="true" defaultChecked={checked} />
    </SettingRow>
  );
}

function TtlField({ field, value }: { field: SettingsFieldView; value: string }) {
  const text = fieldCopy(field, useSettingsCopy());
  return (
    <SettingRow title={text.label} description={text.help} htmlFor={field.key}>
      <div className="w-full">
        <Input id={field.key} name="checkoutTtlDays" type="number" min={0} step={1} defaultValue={value} />
      </div>
    </SettingRow>
  );
}

function CsrfField({ token }: { token: string }) {
  return <input type="hidden" name="csrf" value={token} />;
}

function SectionField({ section }: { section: SettingsSection }) {
  return <input type="hidden" name="section" value={section} />;
}

function modelIds(model: SettingsPageModel, provider: string, current: string): string[] {
  const catalog = model.catalogs.find((item) => item.provider === provider);
  const ids = catalog ? catalog.models.map((item) => item.id) : provider === model.provider ? model.modelOptions : [];
  if (current && !ids.includes(current)) return [current, ...ids];
  return ids;
}

function levelsFor(model: SettingsPageModel, provider: string, modelId: string, current: string): string[] {
  const catalog = model.catalogs.find((item) => item.provider === provider);
  const fromCatalog = catalog?.models.find((item) => item.id === modelId)?.thinking;
  if (fromCatalog && fromCatalog.length > 0) return fromCatalog;
  if (provider === model.provider) {
    const levels = model.thinkingByModel[modelId];
    if (levels && levels.length > 0) return levels;
  }
  return current ? [current] : [];
}
