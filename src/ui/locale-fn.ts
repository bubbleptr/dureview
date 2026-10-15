import { createServerFn } from "@tanstack/react-start";
import { resolveLocale, type Locale } from "./locale.js";

export const getUiLocale = createServerFn({ method: "GET" }).handler(async (): Promise<{ locale: Locale }> => {
  const { getRequest } = await import("@tanstack/react-start/server");
  return { locale: resolveLocale(getRequest()) };
});
