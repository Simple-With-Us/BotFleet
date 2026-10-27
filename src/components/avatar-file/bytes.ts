// Browser bytes for the shared manifest reader.
//
// `shared/avatar-manifest.ts` walks a WebP by reading its RIFF chunks, and it
// does that with the slice of Node's `Buffer` API a chunk reader needs:
// `readUInt32LE` for a chunk's size, and `toString("latin1")` /
// `toString("utf8")` for a chunk's payload.  A browser has no `Buffer`
// global, so this module supplies that slice over a `Uint8Array`.
//
// The cast to `Buffer` is deliberate and narrow: the shared reader is the
// contract, and it only ever calls the three methods above.  If the shared
// reader grows a fourth Buffer call, this shim has to grow with it, and this
// is the one place to look when a manifest stops being found in the browser.

/**
 * A `Uint8Array` that answers the Buffer calls the manifest reader makes.
 *
 * `subarray` needs no override: the typed array methods build their result
 * with the receiver's own constructor, so a slice of this is another
 * `WebpBytes` and keeps the `toString` below.
 */
class WebpBytes extends Uint8Array {
  /** A little-endian 32-bit unsigned read, as a chunk size is stored. */
  readUInt32LE(offset: number): number {
    return (
      (this[offset] ?? 0) +
      ((this[offset + 1] ?? 0) << 8) +
      ((this[offset + 2] ?? 0) << 16) +
      ((this[offset + 3] ?? 0) * 0x1000000)
    );
  }

  /**
   * The two encodings the reader asks for.
   *
   * `latin1` is one character per byte, which is how a four-character chunk
   * type is read.  `utf8` is the manifest's own JSON, so it needs a real
   * decoder rather than a byte-to-character mapping.
   */
  toString(encoding?: string): string {
    if (encoding === "utf8" || encoding === "utf-8") return new TextDecoder().decode(this);
    let out = "";
    for (const byte of this) out += String.fromCharCode(byte);
    return out;
  }
}

/**
 * The bytes the shared manifest reader can read.
 *
 * In Node (tests, the server) the real `Buffer` is there and is used.  In the
 * browser it is not, and the shim above stands in for it.
 */
export function toManifestBytes(bytes: Uint8Array): Buffer {
  // Node has a real Buffer (tests, the server); a browser does not, and the
  // optional call is what tells the two apart without a typeof check.
  const fromNode = globalThis.Buffer?.from(bytes);
  if (fromNode) return fromNode;
  // SAFETY: WebpBytes answers the three Buffer methods the manifest reader
  // calls, and the reader is the only thing this value is handed to.
  return new WebpBytes(bytes) as Buffer;
}
