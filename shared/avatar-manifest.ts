import { z } from "zod";

/**
 * One-file animated avatars.
 *
 * A TV-Face pack is a hundred files: forty expressions, each an `_enter.gif`,
 * a `_hold.gif`, a `_return.gif` and a still.  That is the right shape for art
 * that is cut once and recoloured many times, and the wrong shape for anyone
 * who wants to hand the product a single new avatar.  This module defines the
 * other shape: ONE animated file, with the frame ranges that make up its
 * segments described by a manifest EMBEDDED IN THAT FILE.
 *
 * The manifest travels inside the container rather than beside it, so adding an
 * avatar is a file upload and nothing else.  There is no new attachment
 * record, no new bot field, no second file to keep in sync, and no server
 * change: the attachment store already stores bytes untouched and serves them
 * with their true type.
 *
 * A reader that finds no manifest treats the file as an ordinary looping
 * image, so a plain animated GIF or WebP keeps working exactly as it does
 * today.  The manifest is an upgrade, never a requirement.
 */

/** The four-character RIFF chunk that carries the manifest. */
export const AVATAR_MANIFEST_CHUNK = "AVAT";

/** Bumped when the manifest shape changes incompatibly. */
export const AVATAR_MANIFEST_FORMAT_VERSION = 1;

/**
 * A contiguous, inclusive run of frames.
 *
 * `from` and `to` are both inclusive, so `{from: 0, to: 9}` is ten frames.
 */
export const avatarRangeSchema = z.object({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});
export type AvatarRange = z.infer<typeof avatarRangeSchema>;

/**
 * What one bot state looks like.
 *
 * `hold` is the looping range that state rests on.  `enter` plays once on the
 * way in and then hands over to `hold`.  `return` plays once on the way out
 * and then hands back to whatever the previous state was resting on.  A state
 * with no `hold` is a static state and renders the resting frame.
 */
export const avatarStateSchema = z.object({
  enter: avatarRangeSchema.optional(),
  hold: avatarRangeSchema.optional(),
  return: avatarRangeSchema.optional(),
});
export type AvatarState = z.infer<typeof avatarStateSchema>;

/**
 * The manifest.
 *
 * `states` is keyed by BotFleet bot state name.  The wildcard key `*` is the
 * fallback for any state the manifest does not name, which is what lets a
 * simple avatar declare one resting loop and one working loop without listing
 * all fifty bot states.
 */
export const avatarManifestSchema = z.object({
  formatVersion: z.number().int().min(1),
  name: z.string().min(1),
  version: z.string().optional(),
  author: z.string().optional(),
  /** Informational: the file name the manifest was authored against. */
  file: z.string().optional(),
  frame: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    count: z.number().int().positive(),
    delayMs: z.number().int().positive(),
  }),
  /** The frame that is the avatar's canonical resting pose. */
  restingFrame: z.number().int().min(0),
  states: z.record(z.string(), avatarStateSchema),
});
export type AvatarManifest = z.infer<typeof avatarManifestSchema>;

/** The state key that means "any state not named explicitly". */
export const AVATAR_ANY_STATE = "*";

/**
 * Read a manifest from its JSON text.
 *
 * The text is the boundary: the JSON is parsed and the shape is checked here,
 * so every caller downstream works with a real manifest or with nothing at all.
 * Text that is not JSON, and JSON that does not match the schema, both come
 * back as null, because a malformed manifest must never take an avatar down.
 */
export function parseAvatarManifest(text: string): AvatarManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = avatarManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The state entry that applies to `state`: its own name if the manifest has
 * one, otherwise the wildcard, otherwise null.
 */
export function avatarStateFor(manifest: AvatarManifest, state: string): AvatarState | null {
  return manifest.states[state] ?? manifest.states[AVATAR_ANY_STATE] ?? null;
}

/**
 * One planned step of playback.
 *
 * `mode` is `once` for a transition that runs to the end and stops, and
 * `loop` for a range that repeats until something else is asked for.
 */
export interface AvatarStep {
  range: AvatarRange;
  mode: "once" | "loop";
  /** Why this step is playing, for logs and for the player to name it. */
  reason: "enter" | "hold" | "return" | "resting";
}

/**
 * Clamp a range to the frames the file actually has.
 *
 * A manifest is authored by hand, so an off-by-one that points past the last
 * frame is a mistake waiting to happen.  Clamping here means a wrong range
 * plays the last frame instead of throwing or drawing nothing.
 */
function clampRange(range: AvatarRange, frameCount: number): AvatarRange {
  const last = Math.max(0, frameCount - 1);
  const from = Math.min(Math.max(0, range.from), last);
  const to = Math.min(Math.max(from, range.to), last);
  return { from, to };
}

/**
 * The steps to play when the avatar moves from `fromState` to `toState`.
 *
 * The order is fixed and is the whole point of the format:
 *
 *   leave the old state  ->  play its `return` once
 *   arrive at the new one  ->  play its `enter` once
 *   then  ->  loop its `hold` forever
 *
 * When the state does not change, only the hold loops: re-asking for the
 * state the avatar is already in is not a transition, and playing the return
 * and the enter again would stutter the animation on every poll.
 *
 * When a state has no `return`, the transition out is instant, which is the
 * same as the cross-fade the plain image path does today.
 */
export function planAvatarSteps(
  manifest: AvatarManifest,
  fromState: string | null,
  toState: string,
): AvatarStep[] {
  const steps: AvatarStep[] = [];
  const changed = fromState !== toState;
  const from = fromState === null ? null : avatarStateFor(manifest, fromState);
  const to = avatarStateFor(manifest, toState);

  if (changed && from?.return) {
    steps.push({ range: clampRange(from.return, manifest.frame.count), mode: "once", reason: "return" });
  }
  if (changed && to?.enter) {
    steps.push({ range: clampRange(to.enter, manifest.frame.count), mode: "once", reason: "enter" });
  }
  if (to?.hold) {
    steps.push({ range: clampRange(to.hold, manifest.frame.count), mode: "loop", reason: "hold" });
  } else {
    steps.push({
      range: { from: manifest.restingFrame, to: manifest.restingFrame },
      mode: "loop",
      reason: "resting",
    });
  }
  return steps;
}

/* ------------------------------------------------------------------ */
/* The WebP container                                                  */
/* ------------------------------------------------------------------ */

interface WebpChunk {
  fourcc: string;
  data: Buffer;
}

function readFourcc(bytes: Buffer, at: number): string {
  return bytes.subarray(at, at + 4).toString("latin1");
}

/**
 * Split a RIFF file into its chunks.
 *
 * A WebP file is `RIFF <size> WEBP` followed by chunks, each a four
 * character type, a little-endian size, and the payload padded to an even
 * length.  The image data is not touched here; this only splits the file.
 */
function parseWebpChunks(bytes: Buffer): WebpChunk[] | null {
  if (bytes.length < 12) return null;
  if (readFourcc(bytes, 0) !== "RIFF" || readFourcc(bytes, 8) !== "WEBP") return null;
  const chunks: WebpChunk[] = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const fourcc = readFourcc(bytes, at);
    const size = bytes.readUInt32LE(at + 4);
    const start = at + 8;
    if (start + size > bytes.length) return null;
    chunks.push({ fourcc, data: bytes.subarray(start, start + size) });
    at = start + size + (size % 2); // chunks are padded to an even length
  }
  return chunks;
}

function buildWebp(chunks: WebpChunk[]): Buffer {
  let payload = 4; // 'WEBP'
  for (const chunk of chunks) payload += 8 + chunk.data.length + (chunk.data.length % 2);
  const out = Buffer.alloc(8 + payload);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(payload, 4);
  out.write("WEBP", 8, "latin1");
  let at = 12;
  for (const chunk of chunks) {
    out.write(chunk.fourcc, at, "latin1");
    out.writeUInt32LE(chunk.data.length, at + 4);
    chunk.data.copy(out, at + 8);
    at += 8 + chunk.data.length + (chunk.data.length % 2);
  }
  return out;
}

/**
 * Put a manifest inside an animated WebP.
 *
 * The manifest replaces any manifest already in the file, so re-running the
 * build over the same output is safe.
 *
 * Only the EXTENDED format can carry it.  A simple WebP is `RIFF/WEBP/VP8 `
 * and a decoder on the simple path expects its image chunk immediately, so
 * pushing an unknown chunk in front of it would corrupt the image.  An
 * ANIMATED WebP is always extended — it needs `VP8X` for the loop flag and
 * the `ANIM`/`ANMF` frame chunks — so this restriction costs nothing in
 * practice and protects the still images.
 */
export function embedAvatarManifest(bytes: Buffer, manifest: AvatarManifest): Buffer {
  const chunks = parseWebpChunks(bytes);
  if (!chunks) throw new Error("not a WebP file: expected a RIFF/WEBP container");
  if (!chunks.some((chunk) => chunk.fourcc === "VP8X")) {
    throw new Error(
      "not an extended WebP: a manifest needs a VP8X chunk, and only an animated WebP has one",
    );
  }
  const payload = Buffer.from(JSON.stringify(manifest), "utf8");
  const withoutManifest = chunks.filter((chunk) => chunk.fourcc !== AVATAR_MANIFEST_CHUNK);
  // VP8X must stay the first chunk; the manifest goes directly after it, and
  // the image data keeps its place at the end of the file.
  withoutManifest.splice(1, 0, {
    fourcc: AVATAR_MANIFEST_CHUNK,
    data: payload,
  });
  return buildWebp(withoutManifest);
}

/**
 * Read a manifest out of an animated file.
 *
 * Returns null for a file with no manifest, a file that is not WebP, and a
 * manifest that does not parse.  A caller that gets null renders the file as
 * an ordinary looping image, which is exactly what every existing animated
 * avatar already does.
 */
export function extractAvatarManifest(bytes: Buffer): AvatarManifest | null {
  const chunks = parseWebpChunks(bytes);
  if (!chunks) return null;
  const chunk = chunks.find((entry) => entry.fourcc === AVATAR_MANIFEST_CHUNK);
  if (!chunk) return null;
  try {
    return parseAvatarManifest(chunk.data.toString("utf8"));
  } catch {
    return null;
  }
}
