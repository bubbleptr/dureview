import { useEffect, useState } from "react";

/** UTC label on the server. After hydration, the same element shows local time. */
export function LocalTime({ iso, label }: { iso: string; label: string }) {
  const [text, setText] = useState(label);
  useEffect(() => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;
    setText(
      new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date),
    );
  }, [iso]);
  return (
    <time dateTime={iso} title={iso}>
      {text}
    </time>
  );
}
