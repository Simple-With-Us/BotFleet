// Shared by the chat-message fence renderers that lazy-load a heavy
// highlighter (ChatMarkdown's CodeBlock → Shiki, MermaidBlock → mermaid):
// a streaming block's content must hold still for STREAM_SETTLE_MS before
// the expensive render runs, and the result is cached under a hash of the
// settled content so a revisited thread mounts straight from cache instead
// of re-rendering. Split out so both renderers reuse one debounce constant
// and one cache-key hash instead of drifting copies.

// how long a streaming block's content must be unchanged before we spend a
// render on it — long enough to skip per-token churn mid-fence, short
// enough that the render lands before the stream settles
export const STREAM_SETTLE_MS = 250;

export const hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};
