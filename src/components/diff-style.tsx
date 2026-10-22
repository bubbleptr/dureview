import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { useSettingsCopy } from "../ui/i18n.js";
import {
  DIFF_STYLE_KEY,
  diffStyleCookie,
  diffStyleFromCookieHeader,
  isDiffStyle,
  type DiffStyle,
} from "../ui/diff-style-pref.js";
import { Button } from "./ui/button.js";

export { DIFF_STYLE_KEY, type DiffStyle } from "../ui/diff-style-pref.js";

const DiffStyleContext = createContext<DiffStyle>("unified");

// False during hydration so the first paint matches the server. Later mounts read the cookie immediately.
let styleReady = false;

export function DiffStyleProvider({ style, children }: { style: DiffStyle; children: ReactNode }) {
  return <DiffStyleContext.Provider value={style}>{children}</DiffStyleContext.Provider>;
}

/** Saved style. The server value matches the cookie so a hard refresh does not paint unified first. */
export function useDiffStyle(): [DiffStyle, (value: DiffStyle) => void] {
  const serverStyle = useContext(DiffStyleContext);
  const [style, setStyle] = useState(() => (styleReady ? readClientDiffStyle(serverStyle) : serverStyle));
  useLayoutEffect(() => {
    styleReady = true;
    const next = readClientDiffStyle(serverStyle);
    setStyle((current) => (current === next ? current : next));
  }, [serverStyle]);
  return [
    style,
    (value) => {
      setStyle(value);
      writeDiffStyle(value);
    },
  ];
}

export function DiffStyleControl() {
  const [style, setStyle] = useDiffStyle();
  const copy = useSettingsCopy().review;
  return (
    <div className="flex gap-1" role="group" aria-label={copy.diffGroup}>
      <Button type="button" size="sm" variant={style === "unified" ? "default" : "outline"} aria-pressed={style === "unified"} onClick={() => setStyle("unified")}>
        {copy.unified}
      </Button>
      <Button type="button" size="sm" variant={style === "split" ? "default" : "outline"} aria-pressed={style === "split"} onClick={() => setStyle("split")}>
        {copy.split}
      </Button>
    </div>
  );
}

function readClientDiffStyle(fallback: DiffStyle): DiffStyle {
  if (typeof document === "undefined") return fallback;
  const fromCookie = diffStyleFromCookieHeader(document.cookie);
  if (fromCookie) return fromCookie;
  try {
    const stored = localStorage.getItem(DIFF_STYLE_KEY);
    if (isDiffStyle(stored)) {
      document.cookie = diffStyleCookie(stored);
      return stored;
    }
  } catch {
    // Storage can be blocked. The server value stands.
  }
  return fallback;
}

function writeDiffStyle(value: DiffStyle): void {
  try {
    localStorage.setItem(DIFF_STYLE_KEY, value);
  } catch {
    // The choice still applies until reload.
  }
  if (typeof document !== "undefined") document.cookie = diffStyleCookie(value);
}
