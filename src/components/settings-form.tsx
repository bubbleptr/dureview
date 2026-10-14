import { useState, type ReactNode } from "react";
import type { SettingsFieldView, SettingsPageModel } from "../settings/page.js";
import { nearestThinking } from "../settings/thinking.js";
import { formatTime } from "../ui/page.js";
import { LocalTime } from "./local-time.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { NativeSelect } from "./ui/native-select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.js";
import { UiNav } from "./ui-nav.js";

const TRIGGERS = ["manual", "once", "auto"] as const;

export function SettingsForm({ model }: { model: SettingsPageModel }) {
  const [modelId, setModelId] = useState(model.form.model);
  const [thinking, setThinking] = useState<string>(model.form.thinking);
  const levels = levelsFor(model, modelId, thinking);
  const thinkingValue = levels.includes(thinking) ? thinking : (levels[0] ?? thinking);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Settings</CardTitle>
            <UiNav current="settings" />
          </div>
          <CardDescription>
            Changes apply to new reviews. A review that is already running keeps the model and thinking it started with.
            An override wins over the environment variable, which wins over the built-in default.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Provider <b>{model.provider}</b>. Model choices are the pi-ai catalog for this provider.
          </p>
          {model.error ? (
            <p className="text-sm text-red-700" role="alert">
              {model.error}
            </p>
          ) : null}
          {model.saved ? <p className="text-sm text-green-800">Saved. New reviews use these settings.</p> : null}
          {model.problems.map((problem) => (
            <p key={problem} className="text-sm text-red-700">
              {problem}
            </p>
          ))}
          <form className="flex flex-col gap-5" method="post" action="/ui/settings">
            <ModelField
              field={model.fields.model}
              options={model.modelOptions}
              value={modelId}
              onChange={(next) => {
                setModelId(next);
                const nextLevels = levelsFor(model, next, thinking);
                setThinking(nearestThinking(nextLevels, thinking));
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
        </CardContent>
      </Card>
    </div>
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
      <NativeSelect id={field.key} name="model" value={value} onChange={(event) => onChange(event.target.value)}>
        {choices.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </NativeSelect>
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
      <NativeSelect id={field.key} name="thinking" value={value} onChange={(event) => onChange(event.target.value)}>
        {choices.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </NativeSelect>
    </FieldShell>
  );
}

function TriggerField({ field, value }: { field: SettingsFieldView; value: string }) {
  return (
    <FieldShell field={field}>
      <NativeSelect id={field.key} name="defaultTrigger" defaultValue={value}>
        {TRIGGERS.map((trigger) => (
          <option key={trigger} value={trigger}>
            {trigger}
          </option>
        ))}
      </NativeSelect>
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
        <span className="text-xs text-muted-foreground">{field.envName}</span>
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

function levelsFor(model: SettingsPageModel, modelId: string, current: string): string[] {
  const levels = model.thinkingByModel[modelId];
  if (levels && levels.length > 0) return levels;
  return current ? [current] : [];
}
