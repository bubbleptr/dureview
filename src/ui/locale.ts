import { safeUiReturn } from "./next-path.js";

export const LOCALES = ["en", "zh-CN"] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_COOKIE = "dureview-locale";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN";
}

/** `zh`, `zh-CN`, `zh-TW`, and `zh-Hans` are Chinese. Every other tag is English. */
export function localeFromLanguageTag(tag: string): Locale {
  const primary = tag.trim().toLowerCase().split("-")[0] ?? "";
  return primary === "zh" ? "zh-CN" : "en";
}

/**
 * The highest-q tag wins. A tie keeps the earlier tag.
 * A missing or unusable header is English.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  const ranked = acceptLanguageTags(header);
  const top = ranked[0];
  if (!top) return "en";
  return localeFromLanguageTag(top);
}

export function localeFromCookieHeader(header: string | null | undefined): Locale | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== LOCALE_COOKIE) continue;
    const value = decodeCookie(trimmed.slice(eq + 1));
    return isLocale(value) ? value : null;
  }
  return null;
}

/** A saved choice wins. Otherwise the browser's preferred language. */
export function resolveLocale(request: { headers: { get(name: string): string | null } }): Locale {
  return localeFromCookieHeader(request.headers.get("cookie")) ?? localeFromAcceptLanguage(request.headers.get("accept-language"));
}

export function localeFromMatches(matches: ReadonlyArray<{ loaderData?: unknown }>): Locale {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const data = matches[index]?.loaderData;
    if (typeof data !== "object" || data === null || !("locale" in data)) continue;
    if (isLocale(data.locale)) return data.locale;
  }
  return "en";
}

export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

export function localeHref(locale: Locale, returnTo: string): string {
  const params = new URLSearchParams({ locale, next: safeUiReturn(returnTo) });
  return `/ui/locale?${params.toString()}`;
}

export function acceptLanguageTags(header: string | null | undefined): string[] {
  if (!header) return [];
  const ranked: Array<{ tag: string; q: number; index: number }> = [];
  let index = 0;
  for (const part of header.split(",")) {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag?.trim() ?? "";
    if (!tag || tag === "*") continue;
    let q = 1;
    for (const param of params) {
      const [key, raw] = param.trim().split("=");
      if (key?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) q = parsed;
    }
    if (q <= 0) continue;
    ranked.push({ tag, q, index });
    index += 1;
  }
  ranked.sort((left, right) => right.q - left.q || left.index - right.index);
  return ranked.map((item) => item.tag);
}

function decodeCookie(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export type MessageTree<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly MessageTree<U>[]
    : T extends Record<string, unknown>
      ? { readonly [K in keyof T]: MessageTree<T[K]> }
      : T;

export function messageKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return prefix ? [prefix] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => messageKeys(item, prefix ? `${prefix}.${index}` : String(index)));
  }
  return Object.keys(value)
    .sort()
    .flatMap((key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const child = (value as Record<string, unknown>)[key];
      if (typeof child === "object" && child !== null) return messageKeys(child, path);
      return [path];
    });
}
