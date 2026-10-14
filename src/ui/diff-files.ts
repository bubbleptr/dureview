/**
 * Map a loaded pair onto the shape `@pierre/diffs` hydrates.
 * Returns null when a changed or renamed file is missing a side, so the caller keeps the hunk patch.
 */
export function toDiffFiles(
  file: { type: string; name: string; prevName?: string },
  loaded: { oldText: string | null; newText: string | null },
):
  | { oldFile: null; newFile: { name: string; contents: string } }
  | { oldFile: { name: string; contents: string }; newFile: { name: string; contents: string } }
  | null {
  if (loaded.newText === null) return null;
  const newFile = { name: file.name, contents: loaded.newText };
  if (file.type === "rename-pure") return { oldFile: null, newFile };
  if (loaded.oldText === null) return null;
  return { oldFile: { name: file.prevName ?? file.name, contents: loaded.oldText }, newFile };
}
