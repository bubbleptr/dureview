import { afterEach, describe, expect, it } from "vitest";
import { settingsCsrfToken } from "../src/http/csrf.js";
import { startHttp } from "../src/server.js";
import { safeUiReturn } from "../src/ui/next-path.js";
import { runningLabel } from "../src/ui/page.js";
import {
  localeFromAcceptLanguage,
  localeFromCookieHeader,
  localeHref,
  messageKeys,
  resolveLocale,
} from "../src/ui/locale.js";
import { messages } from "../src/ui/messages.js";
import { settingsCatalog } from "../src/ui/settings-copy.js";
import { MemoryGitHub, openTestService, reviewRequest, scriptedReview, tempDataDir } from "./support.js";

const UI_TOKEN = "ui-token-canary-not-in-page";

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

  it("keeps the current path and query on a same-origin UI return", () => {
    const detail = "/ui/reviews/shot1?sort=when&dir=desc&page=2";
    const list = "/ui/reviews?repo=acme%2Fdemo&result=clean&sort=when&dir=desc&page=2";
    expect(safeUiReturn(detail)).toBe(detail);
    expect(safeUiReturn(list)).toBe(list);
    expect(localeHref("zh-CN", detail)).toBe(`/ui/locale?locale=zh-CN&next=${encodeURIComponent(detail)}`);
    expect(localeHref("zh-CN", "/ui/login")).toBe("/ui/locale?locale=zh-CN&next=%2Fui%2Flogin");
    expect(localeHref("zh-CN", "/ui/settings/github")).toBe("/ui/locale?locale=zh-CN&next=%2Fui%2Fsettings%2Fgithub");
    for (const blocked of [
      "https://evil.example/phish",
      "//evil.example/phish",
      "/ui/../secret",
      "/ui/%2e%2e/secret",
      "/ui-evil",
      "/ui/reviews/..%2f..%2fsecret",
      `/ui/${"a".repeat(3000)}`,
    ]) {
      expect(safeUiReturn(blocked)).toBe("/ui");
      expect(localeHref("en", blocked)).toBe("/ui/locale?locale=en&next=%2Fui");
    }
  });

  it("labels a running review in the active language", () => {
    const now = Date.parse("2026-10-13T16:00:00.000Z");
    const started = new Date(now - 5 * 60 * 1000).toISOString();
    expect(runningLabel(started, now, "zh-CN")).toBe("进行中");
    expect(runningLabel(started, now, "en")).toBe("Running");
    expect(runningLabel(new Date(now - 30 * 60 * 1000).toISOString(), now, "zh-CN")).toBe("疑似卡住");
  });
});

describe("locale switch without scripts", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it("sets the cookie from the login and settings error pages and stays on this site", async () => {
    const dataDir = await tempDataDir();
    const { service } = await openTestService({
      dataDir,
      github: new MemoryGitHub(),
      fauxModels: [
        { id: "faux-1", reasoning: true },
        { id: "faux-2", reasoning: true },
      ],
      thinking: "low",
      responses: [],
    });
    const http = await startHttp(service, {
      host: "127.0.0.1",
      port: 0,
      uiToken: UI_TOKEN,
      dataDir,
      provider: "faux",
      modelId: "faux-1",
    });
    closers.push(async () => {
      await http.close();
      await service.close();
    });

    const rejected = await fetch(`${http.url}/ui/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "wrong-token", next: "/ui/reviews/1" }),
    });
    const rejectedHtml = await rejected.text();
    const loginHref = "/ui/locale?locale=zh-CN&amp;next=%2Fui%2Flogin";
    expect(rejectedHtml).toContain(`href="${loginHref}"`);

    const switched = await fetch(`${http.url}/ui/locale?locale=zh-CN&next=${encodeURIComponent("/ui/login")}`, {
      redirect: "manual",
    });
    expect(switched.status).toBe(303);
    expect(switched.headers.get("location")).toBe("/ui/login");
    const setCookie = switched.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("dureview-locale=zh-CN");
    expect(setCookie).not.toContain("HttpOnly");

    const login = await fetch(`${http.url}/ui/login`, { headers: { cookie: "dureview-locale=zh-CN" } });
    expect(await login.text()).toContain("登录");

    const bad = await fetch(`${http.url}/ui/settings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${UI_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(http.url).origin,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({
        model: "not-a-model",
        thinking: "low",
        defaultTrigger: "manual",
        checkoutTtlDays: "30",
        save: "1",
        section: "models",
        csrf: settingsCsrfToken(UI_TOKEN),
      }),
    });
    const settingsHtml = await bad.text();
    expect(bad.status).toBe(400);
    expect(settingsHtml).toContain('href="/ui/locale?locale=zh-CN&amp;next=%2Fui%2Fsettings"');

    const evil = await fetch(`${http.url}/ui/locale?locale=zh-CN&next=${encodeURIComponent("https://evil.example/phish")}`, {
      redirect: "manual",
    });
    expect(evil.status).toBe(303);
    expect(evil.headers.get("location")).toBe("/ui");
    expect(evil.headers.get("location")).not.toContain("evil");

    const ignored = await fetch(`${http.url}/ui/locale?locale=fr&next=${encodeURIComponent("/ui/reviews")}`, {
      redirect: "manual",
    });
    expect(ignored.headers.get("location")).toBe("/ui/reviews");
    expect(ignored.headers.get("set-cookie")).toBeNull();

    const traversal = await fetch(`${http.url}/ui/locale?locale=en&next=${encodeURIComponent("/ui/../secret")}`, {
      redirect: "manual",
    });
    expect(traversal.headers.get("location")).toBe("/ui");
    const prefixed = await fetch(`${http.url}/ui/locale?locale=en&next=${encodeURIComponent("/ui-evil")}`, {
      redirect: "manual",
    });
    expect(prefixed.headers.get("location")).toBe("/ui");
  });

  it("returns to the open review and the filtered list", async () => {
    const dataDir = await tempDataDir();
    const { service } = await openTestService({
      dataDir,
      github: new MemoryGitHub(),
      fauxModels: [{ id: "faux-1", reasoning: true }],
      thinking: "low",
      responses: scriptedReview("kept on this page"),
    });
    const http = await startHttp(service, {
      host: "127.0.0.1",
      port: 0,
      uiToken: UI_TOKEN,
      dataDir,
      provider: "faux",
      modelId: "faux-1",
    });
    closers.push(async () => {
      await http.close();
      await service.close();
    });
    const queued = await service.enqueue(reviewRequest(), { kind: "sha" }, "opened");
    await service.wait(queued.taskId);
    const auth = { authorization: `Bearer ${UI_TOKEN}` };

    const detailPath = `/ui/reviews/${String(queued.taskId)}`;
    const detail = await fetch(`${http.url}${detailPath}`, { headers: auth });
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain(localeLink("zh-CN", detailPath));
    const detailSwitch = await fetch(`${http.url}${localeHref("zh-CN", detailPath)}`, { redirect: "manual" });
    expect(detailSwitch.status).toBe(303);
    expect(detailSwitch.headers.get("location")).toBe(detailPath);
    expect(detailSwitch.headers.get("set-cookie")).toContain("dureview-locale=zh-CN");

    const listPath = "/ui/reviews?repo=acme%2Fdemo&result=clean&sort=when&dir=desc&page=2";
    const list = await fetch(`${http.url}${listPath}`, { headers: auth });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(localeLink("zh-CN", listPath));
    const listSwitch = await fetch(`${http.url}${localeHref("en", listPath)}`, { redirect: "manual" });
    expect(listSwitch.headers.get("location")).toBe(listPath);

    const section = await fetch(`${http.url}/ui/settings/github`, { headers: auth });
    expect(section.status).toBe(200);
    expect(await section.text()).toContain(localeLink("zh-CN", "/ui/settings/github"));
  });
});

function localeLink(locale: "en" | "zh-CN", path: string): string {
  return `href="${localeHref(locale, path).replaceAll("&", "&amp;")}"`;
}
