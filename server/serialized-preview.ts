/** Take a prefix of `text` whose JSON-serialized form (without the quotes)
 * is at most `maxBytes` of UTF-8.  Counting UTF-16 units under-counts CJK
 * (3 bytes each) and control characters (a NUL serializes as the 6-byte
 * "\u0000"), so a unit-count slice can blow a response budget; walking code
 * points also never splits an emoji's surrogate pair. */
export function serializedPreview(text: string, maxBytes: number): { preview: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(JSON.stringify(codePoint), "utf8") - 2;
    if (bytes + size > maxBytes) return { preview: text.slice(0, end), truncated: true };
    bytes += size;
    end += codePoint.length;
  }
  return { preview: text, truncated: false };
}

/** Hold a list response under a total serialized budget.  Per-field caps
 * cannot guarantee this on their own: 100 rows of fixed fields plus
 * escape-heavy names already sit near the limit.  Degrade in order of least
 * information lost: clear previews from the last row backwards (each keeps
 * its `instructionsPreviewTruncated: true`, and full instructions stay one
 * `routine_id` lookup away), then drop trailing rows and report how many
 * were omitted. */
export function fitListToBudget<T extends { instructionsPreview: string; instructionsPreviewTruncated: boolean }>(
  envelope: Record<string, unknown>,
  rows: readonly T[],
  maxBytes: number,
  /** Rows the caller already cut before this call (the 100-row cap).  They
   * count toward routinesOmitted, and the budget includes that field. */
  alreadyOmitted = 0,
): { routines: T[]; routinesOmitted?: number } {
  const kept = rows.map((row) => ({ ...row }));
  let omitted = Math.max(0, alreadyOmitted);
  const body = () => (omitted > 0 ? { routines: kept, routinesOmitted: omitted } : { routines: kept });
  const fits = () => Buffer.byteLength(JSON.stringify({ ...envelope, ...body() }), "utf8") <= maxBytes;
  for (let i = kept.length - 1; i >= 0 && !fits(); i--) {
    if (kept[i].instructionsPreview) {
      kept[i].instructionsPreview = "";
      kept[i].instructionsPreviewTruncated = true;
    }
  }
  while (kept.length > 0 && !fits()) {
    kept.pop();
    omitted += 1;
  }
  return body();
}
