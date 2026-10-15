import { PRIORITY_CHART, PRIORITY_CHART_DARK } from "./chart-palette.js";
import { gitDiffText } from "./diff.js";
import type { DetailFileView, DetailLineView } from "./detail-model.js";

/** Lines of patch context kept above and below a commented line. */
export const COMMENT_CONTEXT_LINES = 10;

export type FocusSegment =
  | { kind: "shown"; start: number; end: number; collapsible: boolean }
  | { kind: "hidden"; start: number; end: number; lines: number };

const PRIORITY_COLOR = PRIORITY_CHART;
const PRIORITY_COLOR_DARK = PRIORITY_CHART_DARK;

/** Stable id for a hidden span so expanding and collapsing returns to the same gap. */
export function gapKey(start: number, end: number): string {
  return `${start}:${end}`;
}

/** Content lines a comment sits on, plus any line that carries the comment card. */
export function commentAnchorIndexes(lines: readonly DetailLineView[]): number[] {
  const indexes: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind === "hunk") return;
    if (line.comments.length > 0 || line.severity !== null) indexes.push(index);
  });
  return indexes;
}

/**
 * Windows of context around comments. Everything else is a hidden span.
 * `expanded` lists gap keys the reader has opened; those spans stay visible
 * and are marked collapsible so they can be hidden again.
 * A file with no anchors is one shown span: the file header decides whether it is open.
 */
export function focusSegments(
  lines: readonly { kind: string }[],
  anchors: readonly number[],
  expanded: ReadonlySet<string>,
  radius = COMMENT_CONTEXT_LINES,
): FocusSegment[] {
  const count = lines.length;
  if (count === 0) return [];
  if (anchors.length === 0) return [{ kind: "shown", start: 0, end: count - 1, collapsible: false }];

  const contentIndexes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (lines[index]?.kind !== "hunk") contentIndexes.push(index);
  }
  const position = new Map(contentIndexes.map((index, at) => [index, at]));
  const visible = new Array<boolean>(count).fill(false);
  for (const anchor of anchors) {
    const at = position.get(anchor);
    if (at === undefined) continue;
    const from = Math.max(0, at - radius);
    const to = Math.min(contentIndexes.length - 1, at + radius);
    for (let cursor = from; cursor <= to; cursor += 1) {
      const index = contentIndexes[cursor];
      if (index !== undefined) visible[index] = true;
    }
  }
  for (let index = 0; index < count; index += 1) {
    if (lines[index]?.kind === "hunk" && visible[index + 1]) visible[index] = true;
  }

  const segments: FocusSegment[] = [];
  let index = 0;
  while (index < count) {
    const shown = visible[index] === true;
    const start = index;
    while (index < count && visible[index] === shown) index += 1;
    const end = index - 1;
    if (shown) {
      segments.push({ kind: "shown", start, end, collapsible: false });
      continue;
    }
    const hiddenLines = contentCount(lines, start, end);
    if (hiddenLines === 0) {
      const previous = segments[segments.length - 1];
      if (previous?.kind === "shown" && !previous.collapsible) previous.end = end;
      continue;
    }
    if (expanded.has(gapKey(start, end))) segments.push({ kind: "shown", start, end, collapsible: true });
    else segments.push({ kind: "hidden", start, end, lines: hiddenLines });
  }
  return segments;
}

export function orderCommentedFirst<T>(items: readonly T[], findings: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, rank: findings(item) > 0 ? 0 : 1 }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item);
}

export function findingRanges(lines: readonly DetailLineView[]): Array<{ start: number; end: number; priority: number }> {
  const byOrdinal = new Map<number, { start: number; end: number; priority: number }>();
  for (const line of lines) {
    for (const comment of line.comments) {
      if (byOrdinal.has(comment.ordinal)) continue;
      const start = Math.min(comment.startLine, comment.endLine);
      const end = Math.max(comment.startLine, comment.endLine);
      byOrdinal.set(comment.ordinal, { start, end, priority: comment.priority });
    }
  }
  return [...byOrdinal.values()].sort((left, right) => right.priority - left.priority || left.start - right.start);
}

/**
 * Shadow-DOM CSS that boxes each comment's new-file line range. Lower priorities
 * are painted first. Dark colors key off `data-theme` on the host because
 * Safari and Firefox do not support `:host-context()`.
 */
export function findingLineCss(ranges: readonly { start: number; end: number; priority: number }[]): string {
  const rules: string[] = [];
  for (const range of ranges) {
    const start = Math.min(range.start, range.end);
    const end = Math.max(range.start, range.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1) continue;
    const color = PRIORITY_COLOR[range.priority] ?? PRIORITY_COLOR[3];
    const dark = PRIORITY_COLOR_DARK[range.priority] ?? PRIORITY_COLOR_DARK[3];
    for (let line = start; line <= end; line += 1) {
      const shadow = lineShadow(line === start, line === end);
      rules.push(
        `[data-line="${line}"]{box-shadow:${shadow};background:color-mix(in srgb,${color} 12%,transparent);--finding-accent:${color}}`,
      );
      rules.push(
        `:host([data-theme=dark]) [data-line="${line}"]{background:color-mix(in srgb,${dark} 18%,transparent);--finding-accent:${dark}}`,
      );
    }
  }
  return rules.join("");
}

/** One-file git diff for a slice of already-parsed lines. Null when the slice has no content. */
export function windowDiffText(
  file: Pick<DetailFileView, "filename" | "status">,
  lines: readonly DetailLineView[],
): string | null {
  const body = unifiedBody(lines);
  if (!body) return null;
  return gitDiffText({
    filename: file.filename,
    previousFilename: null,
    status: file.status,
    patch: body,
  });
}

export function sliceLines(lines: readonly DetailLineView[], start: number, end: number): DetailLineView[] {
  return lines.slice(start, end + 1);
}

function contentCount(lines: readonly { kind: string }[], start: number, end: number): number {
  let count = 0;
  for (let index = start; index <= end; index += 1) {
    if (lines[index]?.kind !== "hunk") count += 1;
  }
  return count;
}

function unifiedBody(lines: readonly DetailLineView[]): string {
  const hunks: DetailLineView[][] = [];
  let current: DetailLineView[] = [];
  const flush = () => {
    if (current.length > 0) hunks.push(current);
    current = [];
  };
  for (const line of lines) {
    if (line.kind === "hunk") flush();
    else current.push(line);
  }
  flush();
  return hunks.map(hunkText).join("\n");
}

function hunkText(body: readonly DetailLineView[]): string {
  const oldStart = firstNumber(body, "oldLabel") ?? 0;
  const newStart = firstNumber(body, "newLabel") ?? 0;
  let oldCount = 0;
  let newCount = 0;
  const rows = body.map((line) => {
    if (line.kind === "add") {
      newCount += 1;
      return `+${line.text}`;
    }
    if (line.kind === "del") {
      oldCount += 1;
      return `-${line.text}`;
    }
    oldCount += 1;
    newCount += 1;
    return ` ${line.text}`;
  });
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...rows].join("\n");
}

function firstNumber(lines: readonly DetailLineView[], key: "oldLabel" | "newLabel"): number | null {
  for (const line of lines) {
    if (line[key] === "") continue;
    const value = Number(line[key]);
    if (Number.isInteger(value)) return value;
  }
  return null;
}

function lineShadow(first: boolean, last: boolean): string {
  const parts = ["inset 3px 0 0 var(--finding-accent)"];
  if (first) parts.push("inset 0 1px 0 var(--finding-accent)");
  if (last) parts.push("inset 0 -1px 0 var(--finding-accent)");
  return parts.join(",");
}
