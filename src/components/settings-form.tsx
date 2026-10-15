import { useState, type ReactNode } from "react";
import type { ProviderCatalog, SettingsFieldView, SettingsPageModel } from "../settings/page.js";
import { nearestThinking } from "../settings/thinking.js";
import { formatTime } from "../ui/page.js";
import type { ShellStatus } from "../ui/shell-status.js";
import { LocalTime } from "./local-time.js";
import { AppShell } from "./app-shell.js";
import { DiffStyleControl } from "./diff-style.js";
import { Connections } from "./settings-connections.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { FormSelect } from "./ui/form-select.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";

const TRIGGERS = ["manual", "once", "auto"] as const;

export function SettingsForm({ model, status = null }: { model: SettingsPageModel; status?: ShellStatus | null }) {
  const [provider, setProvider] = useState(model.form.provider || model.provider);
  const [modelId, setModelId] = useState(model.form.model);
  const [thinking, setThinking] = useState<string>(model.form.thinking);
  const options = modelIds(model, provider, modelId);
  const levels = levelsFor(model, provider, modelId, thinking);
  const thinkingValue = levels.includes(thinking) ? thinking : (levels[0] ?? thinking);

  return (
    <AppShell current="settings" title="Settings">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {status ? <RuntimeStatus status={status} /> : null}
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">
          Changes apply to new reviews. A review that is already running keeps the model and thinking it started with.
          An override wins over the environment variable, which wins over the built-in default.
        </p>
        <DiffStyleControl />
        {model.error ? (
          <p className="text-sm text-destructive" role="alert">
            {model.error}
          </p>
        ) : null}
        {model.notice ? <p className="text-sm">{model.notice}</p> : null}
        {model.saved ? <p className="text-sm">Saved. New reviews use these settings.</p> : null}
        {model.problems.map((problem) => (
          <p key={problem} className="text-sm text-destructive" role="alert">
            {problem}
          </p>
        ))}
        <Connections console={model.console} />
        <form className="flex flex-col gap-5" method="post" action="/ui/settings">
          <h2 className="text-sm font-medium">Review settings</h2>
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
          <TriggerField field={model.fields.defaultTrigger} value={model.form.defaultTrigger} />
          <SkipDraftsField field={model.fields.skipDrafts} checked={model.form.skipDrafts} />
          <TtlField field={model.fields.checkoutTtlDays} value={model.form.checkoutTtlDays} />
          <div>
            <Button type="submit" name="save" value="1">
              Save
            </Button>
          </div>
        </form>
        <Audit audit={model.audit} />
      </div>
    </AppShell>
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
  const listed = catalogs.some((catalog) => catalog.provider === value)
    ? catalogs
    : [{ provider: value, label: value, models: [] }, ...catalogs];
  return (
    <FieldShell field={field}>
      <FormSelect
        id={field.key}
        name="provider"
        value={value}
        options={listed.map((catalog) => ({ value: catalog.provider, label: catalog.label }))}
        onValueChange={onChange}
        variant="select"
      />
    </FieldShell>
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
  const choices = options.includes(value) ? options : [value, ...options];
  return (
    <FieldShell field={field}>
      <FormSelect
        id={field.key}
        name="model"
        value={value}
        options={choices.map((id) => ({ value: id, label: id }))}
        onValueChange={onChange}
        variant="combobox"
        className="font-mono"
      />
    </FieldShell>
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
  const choices = levels.includes(value) ? levels : [value, ...levels];
  return (
    <FieldShell field={field}>
      <FormSelect
        id={field.key}
        name="thinking"
        value={value}
        options={choices.map((level) => ({ value: level, label: level }))}
        onValueChange={onChange}
      />
    </FieldShell>
  );
}

function TriggerField({ field, value }: { field: SettingsFieldView; value: string }) {
  return (
    <FieldShell field={field}>
      <FormSelect id={field.key} name="defaultTrigger" defaultValue={value} options={TRIGGERS.map((trigger) => ({ value: trigger, label: trigger }))} />
    </FieldShell>
  );
}

function SkipDraftsField({ field, checked }: { field: SettingsFieldView; checked: boolean }) {
  return (
    <FieldShell field={field}>
      <label className="flex items-center gap-2 text-sm">
        <input id={field.key} type="checkbox" name="skipDrafts" value="true" defaultChecked={checked} />
        Skip draft pull requests
      </label>
    </FieldShell>
  );
}

function TtlField({ field, value }: { field: SettingsFieldView; value: string }) {
  return (
    <FieldShell field={field}>
      <Input id={field.key} name="checkoutTtlDays" type="number" min={0} step={1} defaultValue={value} />
    </FieldShell>
  );
}

function FieldShell({ field, children }: { field: SettingsFieldView; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={field.key}>{field.label}</Label>
        <Badge variant="outline">{field.sourceLabel}</Badge>
        <span className="font-mono text-xs text-muted-foreground">{field.envName}</span>
      </div>
      {children}
      <p className="text-xs text-muted-foreground">{field.help}</p>
      <p className="text-xs text-muted-foreground">
        Effective <b>{field.value}</b>
        {field.source === "override" ? ". Saved on this page." : null}
        {field.source === "env" ? ". From the environment." : null}
        {field.source === "default" ? ". Built-in default." : null}
        {field.env !== null && field.source !== "env" ? ` Environment is ${field.env}.` : null}
        {field.source !== "default" ? ` Built-in default is ${field.builtin}.` : null}
      </p>
      {field.canReset ? (
        <div>
          <Button
            type="submit"
            name="reset"
            value={field.key}
            variant="outline"
            size="sm"
            form="settings-reset"
            aria-label={`Reset ${field.label}`}
          >
            Reset
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RuntimeStatus({ status }: { status: ShellStatus }) {
  return (
    <section className="flex flex-col gap-1 border-b pb-5 text-sm leading-6">
      <h2 className="text-sm font-medium">Runtime</h2>
      <p className="text-muted-foreground">
        <span className="font-mono">{status.version}</span>
        {" · "}
        up {status.uptime}
      </p>
      <p>
        {status.provider}/<span className="font-mono">{status.model}</span>
        {" · "}
        {status.thinking}
      </p>
      <p>
        {status.codex.kind === "plain" ? (
          status.codex.text
        ) : (
          <>
            {status.codex.lead}
            <LocalTime iso={status.codex.iso} label={status.codex.label} />
          </>
        )}
      </p>
      <p>
        GitHub App <b>{status.githubApp ? "yes" : "no"}</b>
      </p>
      <p>
        GitHub token <b>{status.githubToken ? "yes" : "no"}</b>
      </p>
    </section>
  );
}

function Audit({ audit }: { audit: SettingsPageModel["audit"] }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Recent changes</h2>
      {audit.length === 0 ? <p className="text-sm text-muted-foreground">No changes yet.</p> : null}
      {audit.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Setting</TableHead>
              <TableHead>Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {audit.map((row, index) => (
              <TableRow key={`${row.at}-${row.key}-${index}`}>
                <TableCell className="text-muted-foreground">
                  <LocalTime iso={row.at} label={formatTime(row.at)} />
                </TableCell>
                <TableCell>{row.actor}</TableCell>
                <TableCell>{row.key}</TableCell>
                <TableCell>
                  {row.action === "reset" ? `${row.previous ?? "override"} → reset` : `${row.previous ?? "unset"} → ${row.value}`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      <form id="settings-reset" method="post" action="/ui/settings" />
    </section>
  );
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
