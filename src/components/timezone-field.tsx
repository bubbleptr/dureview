import { useEffect } from "react";

/** Reports the browser offset the way the statistics page does, and keeps it on the next GET. */
export function TimezoneField({ tz }: { tz: number }) {
  useEffect(() => {
    const local = -new Date().getTimezoneOffset();
    if (local === tz) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tz", String(local));
    window.location.replace(url.toString());
  }, [tz]);
  return <input type="hidden" name="tz" defaultValue={tz} />;
}
