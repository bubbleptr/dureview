import { useI18n } from "../ui/i18n.js";
import { LanguageSwitch } from "./language-switch.js";
import { ThemeToggle } from "./theme.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

export function LoginForm({ next, error }: { next: string; error?: string }) {
  const { m } = useI18n();
  return (
    <div className="relative flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-6">
      <div className="absolute top-3 right-3 flex items-center gap-1">
        <LanguageSwitch />
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <p className="text-sm font-medium">dureview</p>
          <CardTitle className="text-base">{m.login.title}</CardTitle>
          <CardDescription>{m.login.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" method="post" action="/ui/login">
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <input type="hidden" name="next" value={next} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ui-token">{m.login.token}</Label>
              <Input id="ui-token" type="password" name="token" autoComplete="current-password" required autoFocus />
            </div>
            <Button type="submit">{m.login.submit}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
