/** New-file line numbers GitHub will accept as `side: RIGHT` comments, by path. */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let path: string | undefined;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      path = undefined;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      path = plusPath(line.slice(4).trim());
      inHunk = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk?.[1]) {
      newLine = Number(hunk[1]);
      inHunk = path !== undefined;
      continue;
    }
    if (line === "") continue;
    if (!inHunk || path === undefined) continue;
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) continue;
    add(map, path, newLine);
    newLine += 1;
  }
  return map;
}

export function truncateDiff(diff: string, maxChars = 100_000): { diff: string; truncated: boolean } {
  if (diff.length <= maxChars) return { diff, truncated: false };
  const cut = diff.lastIndexOf("\n", maxChars);
  const end = cut > 0 ? cut : maxChars;
  return { diff: diff.slice(0, end), truncated: true };
}

function plusPath(raw: string): string | undefined {
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  if (unquoted === "/dev/null") return undefined;
  return unquoted.replace(/^b\//, "");
}

function add(map: Map<string, Set<number>>, path: string, line: number): void {
  if (!Number.isInteger(line) || line < 1) return;
  let set = map.get(path);
  if (!set) {
    set = new Set();
    map.set(path, set);
  }
  set.add(line);
}
