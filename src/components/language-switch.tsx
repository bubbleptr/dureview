import { useI18n } from "../ui/i18n.js";
import { localeHref } from "../ui/locale.js";
import { usePageLocation } from "../ui/page-location.js";

const OPTIONS = [
  ["en", "EN"],
  ["zh-CN", "中"],
] as const;

export function LanguageSwitch() {
  const { locale, m } = useI18n();
  const returnTo = usePageLocation();
  return (
    <div role="group" aria-label={m.language.label} className="language-switch flex items-center rounded-md p-0.5">
      {OPTIONS.map(([value, short]) => {
        const on = locale === value;
        const name = value === "en" ? m.language.en : m.language.zh;
        return (
          <a
            key={value}
            href={localeHref(value, returnTo)}
            aria-pressed={on}
            aria-label={name}
            title={name}
            className={
              on
                ? "inline-flex h-7 items-center rounded-sm bg-accent px-1.5 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                : "inline-flex h-7 items-center rounded-sm px-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            }
          >
            {short}
          </a>
        );
      })}
    </div>
  );
}
