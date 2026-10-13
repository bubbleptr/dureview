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

/** Hidden marker stored on each inline comment when summary comments are off. */
export function findingMarker(fingerprint: string, taskId: string): string {
  return `<!-- dureview:finding ${fingerprint} ${taskId} -->`;
}

/** Hidden marker on a "fixed in <sha>" reply, so a resume does not reply again. */
export function fixedMarker(fingerprint: string, sha: string): string {
  return `<!-- dureview:fixed ${fingerprint} ${sha} -->`;
}

export function parseFindingMarker(body: string): { fingerprint: string; taskId: string } | null {
  const match = /<!-- dureview:finding ([0-9a-f]{12}) (\S+) -->/.exec(body);
  if (!match?.[1] || !match[2]) return null;
  return { fingerprint: match[1], taskId: match[2] };
}

/**
 * Hidden finding marker, or the visible `fp:` footer written on summary-mode inline comments.
 * The footer has no task id, so a resume of the task that posted it is not treated as that task's write.
 */
function parseInlineIdentity(body: string): { fingerprint: string; taskId: string } | null {
  const hidden = parseFindingMarker(body);
  if (hidden) return hidden;
  const footer = /<sub>dureview · fp:([0-9a-f]{12})/.exec(body);
  if (!footer?.[1]) return null;
  return { fingerprint: footer[1], taskId: "" };
}

/** One posted inline comment that can still be deduped or resolved. */
export type InlineLedgerEntry = {
  fingerprint: string;
  taskId: string;
  commentId: number;
  reviewId: number | null;
  threadId: string | null;
  /** True when this thread was already resolved or already has a fixed reply. */
  handled: boolean;
};

export type InlineCommentSnapshot = {
  id: number;
  body: string;
  threadId: string | null;
  inReplyToId: number | null;
  resolved: boolean;
  reviewId?: number | null;
};

/**
 * Read dureview inline comments. One entry per finding thread.
 * A thread that is resolved, or that already has a fixed reply, is `handled`.
 * When a fingerprint has both a handled thread and a newer open thread, the open one wins
 * so a regression can be commented on again.
 */
export function readInlineLedger(comments: readonly InlineCommentSnapshot[]): InlineLedgerEntry[] {
  const fixedThreads = new Map<string, Set<string>>();
  for (const comment of comments) {
    for (const fingerprint of fixedFingerprints(comment.body)) {
      const threads = fixedThreads.get(fingerprint) ?? new Set<string>();
      threads.add(threadKey(comment));
      fixedThreads.set(fingerprint, threads);
    }
  }
  const resolvedThreads = new Set<string>();
  for (const comment of comments) {
    if (comment.resolved && comment.threadId) resolvedThreads.add(comment.threadId);
  }

  const grouped = new Map<string, InlineCommentSnapshot[]>();
  for (const comment of comments) {
    const parsed = parseInlineIdentity(comment.body);
    if (!parsed || comment.inReplyToId != null) continue;
    const list = grouped.get(parsed.fingerprint) ?? [];
    list.push(comment);
    grouped.set(parsed.fingerprint, list);
  }

  const entries: InlineLedgerEntry[] = [];
  for (const [fingerprint, group] of grouped) {
    const openComment = group.find(
      (comment) => !commentHandled(comment, fingerprint, fixedThreads, resolvedThreads),
    );
    const chosen = openComment ?? group[0];
    if (!chosen) continue;
    const parsed = parseInlineIdentity(chosen.body);
    entries.push({
      fingerprint,
      taskId: parsed?.taskId ?? "",
      commentId: chosen.id,
      reviewId: chosen.reviewId ?? null,
      threadId: chosen.threadId,
      handled: openComment === undefined,
    });
  }
  return entries;
}

/** Review id of an inline comment this task already posted, if any. */
export function reviewIdPostedByTask(comments: readonly InlineCommentSnapshot[], taskId: string): number | null | undefined {
  for (const comment of comments) {
    const parsed = parseFindingMarker(comment.body);
    if (parsed?.taskId !== taskId || comment.inReplyToId != null) continue;
    return comment.reviewId ?? null;
  }
  return undefined;
}

function commentHandled(
  comment: InlineCommentSnapshot,
  fingerprint: string,
  fixedThreads: Map<string, Set<string>>,
  resolvedThreads: Set<string>,
): boolean {
  if (fixedThreads.get(fingerprint)?.has(threadKey(comment))) return true;
  if (comment.resolved) return true;
  if (comment.threadId !== null && resolvedThreads.has(comment.threadId)) return true;
  return false;
}

function threadKey(comment: InlineCommentSnapshot): string {
  if (comment.threadId) return `thread:${comment.threadId}`;
  return `comment:${comment.inReplyToId ?? comment.id}`;
}

function fixedFingerprints(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/<!-- dureview:fixed ([0-9a-f]{12}) (\S+) -->/g)) {
    if (match[1]) found.push(match[1]);
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
