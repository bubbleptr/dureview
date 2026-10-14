import { useEffect, useState } from "react";
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
  return (
    <section className="flex flex-col gap-2 border-b pb-5">
      <h2 className="text-sm font-medium">Diff view</h2>
      <p className="text-sm leading-6 text-muted-foreground">Unified or split. Saved in this browser, not on the server.</p>
      <div className="flex gap-1">
        <Button type="button" size="sm" variant={style === "unified" ? "default" : "outline"} aria-pressed={style === "unified"} onClick={() => setStyle("unified")}>
          Unified
        </Button>
        <Button type="button" size="sm" variant={style === "split" ? "default" : "outline"} aria-pressed={style === "split"} onClick={() => setStyle("split")}>
          Split
        </Button>
      </div>
    </section>
  );
}
