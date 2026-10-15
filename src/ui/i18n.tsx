import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "./locale.js";
import { messages, type Messages } from "./messages.js";
import { settingsCatalog, type SettingsCopy } from "./settings-copy.js";

const I18nContext = createContext<Locale>("en");

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <I18nContext.Provider value={locale}>{children}</I18nContext.Provider>;
}

export function useI18n(): { locale: Locale; m: Messages } {
  const locale = useContext(I18nContext);
  return { locale, m: messages[locale] };
}

export function useSettingsCopy(): SettingsCopy {
  const { locale } = useI18n();
  return settingsCatalog(locale);
}
