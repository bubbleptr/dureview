import { describe, expect, it } from "vitest";
import { runningLabel } from "../src/ui/page.js";
import {
  localeFromAcceptLanguage,
  localeFromCookieHeader,
  messageKeys,
  resolveLocale,
} from "../src/ui/locale.js";
import { messages } from "../src/ui/messages.js";
import { settingsCatalog } from "../src/ui/settings-copy.js";

describe("locale detection", () => {
  it("maps any zh tag to Chinese and everything else to English", () => {
    expect(localeFromAcceptLanguage("zh")).toBe("zh-CN");
    expect(localeFromAcceptLanguage("zh-CN")).toBe("zh-CN");
    expect(localeFromAcceptLanguage("zh-TW")).toBe("zh-CN");
    expect(localeFromAcceptLanguage("zh-Hans")).toBe("zh-CN");
    expect(localeFromAcceptLanguage("zh-Hant-TW")).toBe("zh-CN");
    expect(localeFromAcceptLanguage("en-US")).toBe("en");
    expect(localeFromAcceptLanguage("fr")).toBe("en");
    expect(localeFromAcceptLanguage("*")).toBe("en");
    expect(localeFromAcceptLanguage("")).toBe("en");
    expect(localeFromAcceptLanguage(null)).toBe("en");
  });

  it("lets the highest-q tag win and keeps the earlier tag on a tie", () => {
    expect(localeFromAcceptLanguage("en;q=0.5,zh-CN;q=0.9")).toBe("zh-CN");
    expect(localeFromAcceptLanguage("zh-CN,en")).toBe("zh-CN");
    expect(localeFromAcceptLanguage("en,zh-CN;q=0.8")).toBe("en");
  });

  it("prefers a saved cookie and ignores an invalid one", () => {
    const request = (cookie: string | null, accept: string | null) => ({
      headers: {
        get(name: string) {
          if (name === "cookie") return cookie;
          if (name === "accept-language") return accept;
          return null;
        },
      },
    });
    expect(resolveLocale(request("dureview-locale=zh-CN", "en-US"))).toBe("zh-CN");
    expect(resolveLocale(request("dureview-locale=en", "zh-CN"))).toBe("en");
    expect(resolveLocale(request("dureview-locale=fr", "zh-TW"))).toBe("zh-CN");
    expect(resolveLocale(request(null, "zh"))).toBe("zh-CN");
    expect(localeFromCookieHeader("other=1; dureview-locale=en")).toBe("en");
    expect(localeFromCookieHeader("dureview-locale=nope")).toBeNull();
  });

  it("keeps the same keys in both dictionaries", () => {
    expect(messageKeys(messages["zh-CN"])).toEqual(messageKeys(messages.en));
    expect(messageKeys(settingsCatalog("zh-CN"))).toEqual(messageKeys(settingsCatalog("en")));
  });

  it("labels a running review in the active language", () => {
    const now = Date.parse("2026-10-13T16:00:00.000Z");
    const started = new Date(now - 5 * 60 * 1000).toISOString();
    expect(runningLabel(started, now, "zh-CN")).toBe("进行中");
    expect(runningLabel(started, now, "en")).toBe("Running");
    expect(runningLabel(new Date(now - 30 * 60 * 1000).toISOString(), now, "zh-CN")).toBe("疑似卡住");
  });
});
