import type { PullFile } from "../../src/github/client.js";
import type { StoredComment } from "../../src/review/archive.js";
import type { DetailCommentView, DetailFileView, DetailLineView } from "../../src/ui/detail-model.js";
import { fileStatusMark, parsePatch, placeReview } from "../../src/ui/diff.js";

const PATCH_CAP = 200_000;

export type BenchFixture = {
  name: "small" | "large";
  files: DetailFileView[];
  changedLines: number;
  totalPatchChars: number;
  largestPatchChars: number;
  largestGitPatchChars: number;
};

export function smallFixture(): BenchFixture {
  return pack("small", [
    file("src/a-toggle.tsx", 48, true),
    file("src/b-panel.tsx", 36, false),
    file("src/c-list.ts", 28, false),
  ]);
}

export function largeFixture(): BenchFixture {
  return pack("large", [
    file("src/a-toggle.tsx", 48, true),
    file("src/m-session.ts", 520, false),
    file("src/m-list.tsx", 420, false),
    file("src/m-theme.ts", 360, false),
    file("src/z-large.tsx", 199_000, false),
  ]);
}

export function behaviorFiles(): DetailFileView[] {
  return pack("small", [file("src/a-noted.tsx", 24, true), file("src/b-folded.tsx", 160, false)]).files;
}

function pack(name: "small" | "large", files: PullFile[]): BenchFixture {
  const comments = files.flatMap((entry, index) => (entry.previousFilename === "comment" ? [comment(entry, index)] : []));
  const cleaned = files.map((entry) => ({ ...entry, previousFilename: null }));
  const largestGitPatchChars = cleaned.reduce((max, entry) => Math.max(max, entry.patch?.length ?? 0), 0);
  const placed = placeReview(cleaned, comments);
  const views = placed.files.map(toView);
  let changedLines = 0;
  let totalPatchChars = 0;
  let largestPatchChars = 0;
  for (const view of views) {
    for (const line of view.lines) {
      if (line.kind === "add" || line.kind === "del") changedLines += 1;
    }
    const chars = view.diffText?.length ?? 0;
    totalPatchChars += chars;
    if (chars > largestPatchChars) largestPatchChars = chars;
  }
  return { name, files: views, changedLines, totalPatchChars, largestPatchChars, largestGitPatchChars };
}

function file(filename: string, size: number, withComment: boolean): PullFile {
  const patch = size > 5_000 ? growPatch(size) : fixedPatch(size);
  return {
    filename,
    status: "modified",
    additions: 0,
    deletions: 0,
    patch,
    previousFilename: withComment ? "comment" : null,
  };
}

function comment(entry: PullFile, ordinal: number): StoredComment {
  const line = parsePatch(entry.patch ?? "").find((row) => row.kind === "add" && row.newLine !== null);
  const at = line?.newLine ?? 1;
  return {
    ordinal,
    path: entry.filename,
    startLine: at,
    endLine: at,
    priority: 1,
    kind: "bug",
    findingType: "bug",
    subtype: "non_severe",
    category: "correctness",
    title: "Skipped billing check",
    body: "Positive amounts return before the charge is captured.",
    trigger: "amount is greater than zero",
    suggestion: "return gateway.capture(amount);",
    confidence: 0.9,
    fingerprint: "0123456789ab",
    evidence: ["src/pay.ts"],
  };
}

function fixedPatch(rows: number): string {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (let index = 0; index < rows; index += 1) {
    const kind = rowKind(index);
    body.push(prefixed(kind, index));
    if (kind !== "add") oldCount += 1;
    if (kind !== "del") newCount += 1;
  }
  return `@@ -1,${oldCount} +1,${newCount} @@\n${body.join("\n")}`;
}

function growPatch(target: number): string {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let bodyChars = 0;
  for (let index = 0; index < 20_000; index += 1) {
    const kind = rowKind(index);
    const row = prefixed(kind, index);
    const nextOld = oldCount + (kind === "add" ? 0 : 1);
    const nextNew = newCount + (kind === "del" ? 0 : 1);
    const header = `@@ -1,${nextOld} +1,${nextNew} @@`;
    const nextChars = header.length + 1 + bodyChars + (body.length === 0 ? 0 : 1) + row.length;
    if (nextChars > target) break;
    body.push(row);
    bodyChars += (body.length === 1 ? 0 : 1) + row.length;
    oldCount = nextOld;
    newCount = nextNew;
  }
  const patch = `@@ -1,${oldCount} +1,${newCount} @@\n${body.join("\n")}`;
  if (patch.length >= PATCH_CAP) throw new Error(`bench patch is ${patch.length} chars, over the ${PATCH_CAP} cap`);
  return patch;
}

function rowKind(index: number): "context" | "add" | "del" {
  const slot = index % 5;
  if (slot === 0) return "context";
  if (slot === 1) return "del";
  return "add";
}

function prefixed(kind: "context" | "add" | "del", index: number): string {
  const text = codeLine(index);
  if (kind === "add") return `+${text}`;
  if (kind === "del") return `-${text}`;
  return ` ${text}`;
}

function codeLine(index: number): string {
  const name = `field${index}`;
  const slot = index % 7;
  if (slot === 0) return `  if (input.${name} == null) throw new TypeError("missing ${name}");`;
  if (slot === 1) return `  const ${name}: string | null = options.map.get("${name}") ?? fallback(${index});`;
  if (slot === 2) return `  await logger.write({ event: "touch", key: "${name}", n: ${index} });`;
  if (slot === 3) return `  rows.push({ id: "${name}", value: compute(${index}, input.actor) });`;
  if (slot === 4) return `  type Guard${index} = { readonly ${name}: boolean };`;
  if (slot === 5) return `  return <Row key="${name}" index={${index}} label={input.${name}} />;`;
  return `  // keep ${name} aligned with the server schema`;
}

function toView(file: {
  anchor: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  lines: Array<{
    kind: DetailLineView["kind"];
    oldLine: number | null;
    newLine: number | null;
    text: string;
    severity: number | null;
    comments: StoredComment[];
  }>;
  unanchored: StoredComment[];
  patchMissing: boolean;
  patchTruncated: boolean;
  diffText: string | null;
}): DetailFileView {
  return {
    anchor: file.anchor,
    filename: file.filename,
    status: file.status,
    statusMark: fileStatusMark(file.status),
    stats: `+${file.additions} −${file.deletions}`,
    patchMissing: file.patchMissing,
    patchTruncated: file.patchTruncated,
    diffText: file.diffText,
    lines: file.lines.map(toLine),
    unanchored: file.unanchored.map(toComment),
  };
}

function toLine(line: {
  kind: DetailLineView["kind"];
  oldLine: number | null;
  newLine: number | null;
  text: string;
  severity: number | null;
  comments: StoredComment[];
}): DetailLineView {
  return {
    kind: line.kind,
    oldLabel: line.oldLine === null ? "" : String(line.oldLine),
    newLabel: line.newLine === null ? "" : String(line.newLine),
    mark: line.kind === "add" ? "+" : line.kind === "del" ? "−" : line.kind === "context" ? " " : "",
    text: line.text,
    severity: line.severity,
    comments: line.comments.map(toComment),
  };
}

function toComment(comment: StoredComment): DetailCommentView {
  return {
    ordinal: comment.ordinal,
    anchor: `c-${comment.ordinal}`,
    priority: comment.priority,
    findingType: comment.findingType,
    subtype: comment.subtype,
    typeLabel: comment.kind,
    tags: [comment.kind],
    confidence: comment.confidence,
    title: comment.title,
    body: comment.body,
    trigger: comment.trigger,
    evidence: comment.evidence,
    suggestion: comment.suggestion,
    path: comment.path,
    startLine: comment.startLine,
    endLine: comment.endLine,
  };
}
