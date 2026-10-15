import { useEffect, useState } from "react";
import { settingsCopy } from "../ui/settings-copy.js";
import { Button } from "./ui/button.js";

export const DIFF_STYLE_KEY = "dureview-diff-style";
export type DiffStyle = "unified" | "split";

/** Browser preference. The first paint stays unified so it matches the server render. */
export function useDiffStyle(): [DiffStyle, (value: DiffStyle) => void] {
  const [style, setStyle] = useState<DiffStyle>("unified");
  useEffect(() => {
    try {
      const stored = localStorage.getItem(DIFF_STYLE_KEY);
      if (stored === "split" || stored === "unified") setStyle(stored);
    } catch {
      // Storage can be blocked. The diff stays unified.
    }
  }, []);
  return [
    style,
    (value) => {
      setStyle(value);
      try {
        localStorage.setItem(DIFF_STYLE_KEY, value);
      } catch {
        // The choice still applies until reload.
      }
    },
  ];
}

export function DiffStyleControl() {
  const [style, setStyle] = useDiffStyle();
  const copy = settingsCopy.review;
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
