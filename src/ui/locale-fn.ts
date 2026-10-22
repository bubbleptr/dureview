import { createServerFn } from "@tanstack/react-start";
import { resolveDiffStyle, type DiffStyle } from "./diff-style-pref.js";
import { resolveLocale, type Locale } from "./locale.js";

export const getUiLocale = createServerFn({ method: "GET" }).handler(async (): Promise<{ locale: Locale; diffStyle: DiffStyle }> => {
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  return { locale: resolveLocale(request), diffStyle: resolveDiffStyle(request) };
});
