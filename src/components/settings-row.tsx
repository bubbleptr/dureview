import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Label } from "./ui/label.js";

export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="gap-2 px-5 pt-5 pb-0">
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription className="max-w-prose leading-5">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="divide-y px-5 pb-1">{children}</CardContent>
    </Card>
  );
}

export function SettingRow({
  title,
  description,
  htmlFor,
  monoTitle = false,
  children,
}: {
  title: string;
  description: ReactNode;
  htmlFor?: string;
  monoTitle?: boolean;
  children: ReactNode;
}) {
  const titleClass = monoTitle ? "font-mono text-sm font-medium text-foreground" : "text-sm font-medium text-foreground";
  return (
    <div className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-10">
      <div className="min-w-0 max-w-prose flex-1">
        {htmlFor ? (
          <Label htmlFor={htmlFor} className={titleClass}>
            {title}
          </Label>
        ) : (
          <p className={titleClass}>{title}</p>
        )}
        <div className="mt-1 text-sm leading-5 text-muted-foreground">{description}</div>
      </div>
      <div className="flex w-full min-w-0 flex-col items-end gap-2 sm:w-72">{children}</div>
    </div>
  );
}
