import { useEffect, useState } from "react";
import { formatLocalDateTime } from "../ui/format.js";
import { useI18n } from "../ui/i18n.js";

/** UTC label on the server. After hydration, the same element shows local time. */
export function LocalTime({ iso, label }: { iso: string; label: string }) {
  const { locale } = useI18n();
  const [text, setText] = useState(label);
  useEffect(() => {
    const formatted = formatLocalDateTime(iso, locale);
    if (formatted) setText(formatted);
  }, [iso, locale]);
  return (
    <time className="font-mono tabular-nums" dateTime={iso} title={iso}>
      {text}
    </time>
  );
}
