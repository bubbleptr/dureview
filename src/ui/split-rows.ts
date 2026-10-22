import type { DetailLineView } from "./detail-model.js";

export type SplitCodeRow = {
  left: DetailLineView | null;
  right: DetailLineView | null;
};

const MAX_ALIGNMENT_COMPARISONS = 4096;
const MIN_IMPROVEMENT_PER_PAIR = 0.5;

/**
 * Split rows in the order Pierre paints them.
 * A change block pairs deletions with additions by content similarity, and the
 * longer side leaves blank cells, so the placeholder has the same row count
 * as the highlighted diff.
 */
export function splitCodeRows(lines: readonly DetailLineView[]): SplitCodeRow[] {
  const rows: SplitCodeRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.kind === "hunk") {
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      while (index < lines.length && lines[index]?.kind === "context") {
        const context = lines[index];
        if (context) rows.push({ left: context, right: context });
        index += 1;
      }
      continue;
    }
    const start = index;
    while (index < lines.length) {
      const kind = lines[index]?.kind;
      if (kind !== "add" && kind !== "del") break;
      index += 1;
    }
    for (const row of pairChange(lines.slice(start, index))) rows.push(row);
  }
  return rows;
}

function pairChange(lines: readonly DetailLineView[]): SplitCodeRow[] {
  const deletions: DetailLineView[] = [];
  const additions: DetailLineView[] = [];
  for (const line of lines) {
    if (line.kind === "del") deletions.push(line);
    else if (line.kind === "add") additions.push(line);
  }
  const offset = alignmentOffset(deletions, additions);
  const rows: SplitCodeRow[] = [];
  const pairCount = Math.min(deletions.length, additions.length);
  if (offset === 0) {
    const count = Math.max(deletions.length, additions.length);
    for (let index = 0; index < count; index += 1) rows.push({ left: deletions[index] ?? null, right: additions[index] ?? null });
    return rows;
  }
  if (additions.length > deletions.length) {
    for (let index = 0; index < offset; index += 1) rows.push({ left: null, right: additions[index] ?? null });
    for (let index = 0; index < pairCount; index += 1) rows.push({ left: deletions[index] ?? null, right: additions[index + offset] ?? null });
    for (let index = pairCount + offset; index < additions.length; index += 1) rows.push({ left: null, right: additions[index] ?? null });
    return rows;
  }
  for (let index = 0; index < offset; index += 1) rows.push({ left: deletions[index] ?? null, right: null });
  for (let index = 0; index < pairCount; index += 1) rows.push({ left: deletions[index + offset] ?? null, right: additions[index] ?? null });
  for (let index = pairCount + offset; index < deletions.length; index += 1) rows.push({ left: deletions[index] ?? null, right: null });
  return rows;
}

function alignmentOffset(deletions: readonly DetailLineView[], additions: readonly DetailLineView[]): number {
  const pairCount = Math.min(deletions.length, additions.length);
  const surplus = Math.abs(additions.length - deletions.length);
  if (pairCount === 0 || surplus === 0 || pairCount * (surplus + 1) > MAX_ALIGNMENT_COMPARISONS) return 0;
  const strippedDeletions = deletions.map((line) => stripWhitespace(line.text));
  const strippedAdditions = additions.map((line) => stripWhitespace(line.text));
  const additionsAreLonger = additions.length > deletions.length;
  let bestOffset = 0;
  let bestScore = -1;
  for (let offset = 0; offset <= surplus; offset += 1) {
    let score = 0;
    for (let pair = 0; pair < pairCount; pair += 1) {
      const deletion = strippedDeletions[pair + (additionsAreLonger ? 0 : offset)] ?? "";
      const addition = strippedAdditions[pair + (additionsAreLonger ? offset : 0)] ?? "";
      score += lineSimilarity(deletion, addition);
    }
    if (offset === 0) bestScore = score + pairCount * MIN_IMPROVEMENT_PER_PAIR;
    else if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

function stripWhitespace(line: string): string {
  return line.replace(/\s+/g, "");
}

function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLength = Math.max(a.length, b.length);
  const minLength = Math.min(a.length, b.length);
  if (minLength === 0) return 0;
  let prefix = 0;
  while (prefix < minLength && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < minLength - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return (prefix + suffix) / maxLength;
}
