/**
 * Map a loaded pair onto the shape `@pierre/diffs` hydrates.
 * An added file has no old text and a deleted file has no new text; the missing
 * side is empty so expand-context can still hydrate that file.
 * A pure rename passes only the new file. Both sides missing stays null so the
 * caller keeps the hunk patch.
 */
export function toDiffFiles(
  file: { type: string; name: string; prevName?: string },
  loaded: { oldText: string | null; newText: string | null },
):
  | { oldFile: null; newFile: { name: string; contents: string } }
  | { oldFile: { name: string; contents: string }; newFile: { name: string; contents: string } }
  | null {
  if (loaded.oldText === null && loaded.newText === null) return null;
  if (file.type === "rename-pure") {
    if (loaded.newText === null) return null;
    return { oldFile: null, newFile: { name: file.name, contents: loaded.newText } };
  }
  return {
    oldFile: { name: file.prevName ?? file.name, contents: loaded.oldText ?? "" },
    newFile: { name: file.name, contents: loaded.newText ?? "" },
  };
}
