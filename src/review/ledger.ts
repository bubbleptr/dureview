import type { Finding, FindingKind } from "./schema.js";

/** One open finding remembered on the summary comment so the next push can dedupe and mark fixes. */
export type LedgerEntry = {
  fp: string;
  title: string;
  path: string;
  start: number;
  end: number;
  priority: number;
  kind: FindingKind;
};

export function toLedgerEntry(finding: Finding): LedgerEntry {
  return {
    fp: finding.fingerprint,
    title: finding.title,
    path: finding.path,
    start: finding.startLine,
    end: finding.endLine,
    priority: finding.priority,
    kind: finding.kind,
  };
}

export function encodeLedger(entries: LedgerEntry[]): string {
  return Buffer.from(JSON.stringify({ v: 1, open: entries }), "utf8").toString("hex");
}

export function ledgerMarker(entries: LedgerEntry[]): string {
  return `<!-- dureview:ledger ${encodeLedger(entries)} -->`;
}

export function parseLedger(body: string | undefined): LedgerEntry[] {
  if (!body) return [];
  const match = /<!-- dureview:ledger ([0-9a-f]+) -->/.exec(body);
  if (!match?.[1]) return [];
  try {
    const parsed = JSON.parse(Buffer.from(match[1], "hex").toString("utf8")) as { open?: unknown };
    if (!Array.isArray(parsed.open)) return [];
    return parsed.open.filter(isLedgerEntry);
  } catch {
    return [];
  }
}

export function inlineFingerprintMarker(fingerprints: readonly string[]): string {
  return `<!-- dureview:fps ${fingerprints.join(",")} -->`;
}

/** Fingerprints already posted as inline comments, read from review bodies. */
export function postedFingerprints(bodies: Iterable<string>): Set<string> {
  const found = new Set<string>();
  for (const body of bodies) {
    const match = /<!-- dureview:fps ([0-9a-f,]+) -->/.exec(body);
    if (!match?.[1]) continue;
    for (const fingerprint of match[1].split(",")) {
      if (fingerprint) found.add(fingerprint);
    }
  }
  return found;
}

export function disappeared(previous: LedgerEntry[], open: readonly Finding[]): LedgerEntry[] {
  const current = new Set(open.map((finding) => finding.fingerprint));
  const seen = new Set<string>();
  const fixed: LedgerEntry[] = [];
  for (const entry of previous) {
    if (current.has(entry.fp) || seen.has(entry.fp)) continue;
    seen.add(entry.fp);
    fixed.push(entry);
  }
  return fixed;
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LedgerEntry>;
  return (
    typeof entry.fp === "string" &&
    typeof entry.title === "string" &&
    typeof entry.path === "string" &&
    typeof entry.start === "number" &&
    typeof entry.end === "number" &&
    typeof entry.priority === "number" &&
    (entry.kind === "bug" || entry.kind === "security" || entry.kind === "investigate")
  );
}
