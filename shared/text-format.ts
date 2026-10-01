// Two small text helpers the server, the shared modules and the client all
// need, kept in one dependency-free file so none of them has to import a
// heavier module for the sake of a six-line function.

/** Cut `value` to `limit` UTF-16 units without ending on the first half of a
 * surrogate pair — a lone half renders as a replacement glyph. */
export function cutText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let end = Math.max(0, limit);
  const last = value.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** A byte count as a person reads it: `412 B`, `3.2 KB`, `10.0 KB`, `1.4 MB`.
 * The composer's attachment chips and the context-injection rows both say
 * sizes this way, so the same number never reads two ways. */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
