/**
 * One-file animated WebP packs for TV-Face.
 *
 * When a color has a pack listed in SHIPPED_ONE_FILE_PACKS, TVFaceAvatar plays
 * it through AnimatedFileAvatar (embedded AVAT manifest) instead of the
 * multi-GIF skin tree.  Colors without a pack keep the legacy GIF/still player.
 *
 * Packs live under public/tv-face/packs/.  Add a basename to
 * SHIPPED_ONE_FILE_PACKS only after the WebP is committed there.
 */

import type { BotColor } from "@/lib/mascot";

/** Color key for pack lookup (includes default alias). */
export type TVFacePackSkin = BotColor | "default";

/**
 * Basenames under public/tv-face/packs/ that actually ship.
 * Keep in sync with the directory listing (asserted in packs.test.ts).
 */
export const SHIPPED_ONE_FILE_PACKS: ReadonlySet<string> = new Set([
  "tvface-default.webp",
  "tvface-thinking.webp",
  "tvface-blue.webp",
  "tvface-green.webp",
  "tvface-purple.webp",
  "tvface-pink.webp",
  "tvface-red.webp",
  "tvface-cyan.webp",
  "tvface-yellow.webp",
  "tvface-teal.webp",
  "tvface-coral.webp",
  "tvface-white.webp",
  "tvface-black.webp",
]);

/** Primary pack basename for each color.  Orange and default share the same file. */
const PRIMARY_PACK = {
  orange: "tvface-default.webp",
  default: "tvface-default.webp",
  blue: "tvface-blue.webp",
  green: "tvface-green.webp",
  purple: "tvface-purple.webp",
  pink: "tvface-pink.webp",
  red: "tvface-red.webp",
  cyan: "tvface-cyan.webp",
  yellow: "tvface-yellow.webp",
  teal: "tvface-teal.webp",
  coral: "tvface-coral.webp",
  white: "tvface-white.webp",
  black: "tvface-black.webp",
} satisfies Readonly<Partial<Record<TVFacePackSkin, string>>>;

/** Thinking-focused pack (denser enter/hold/return).  Default family only. */
const THINKING_PACK = {
  orange: "tvface-thinking.webp",
  default: "tvface-thinking.webp",
} satisfies Readonly<Partial<Record<TVFacePackSkin, string>>>;

/**
 * States that only the expanded default pack embeds today (beyond thin color
 * shells' `*` / working / speaking).  Non-default colors keep the multi-GIF
 * tree for these until their shells are re-expanded.
 */
const EXPANDED_DEFAULT_ONLY_STATES: ReadonlySet<string> = new Set([
  "listening",
  "tools",
  "computer",
  "memory",
  "fleet",
  "routine",
  "screen",
  "git",
  "webhook",
]);

const PACK_BASE = "/tv-face/packs";

function packUrl(basename: string | undefined): string | null {
  if (!basename) return null;
  if (!SHIPPED_ONE_FILE_PACKS.has(basename)) return null;
  return `${PACK_BASE}/${basename}`;
}

/**
 * The one-file pack URL for this color and bot state, or null when the multi-GIF
 * skin player must run instead.
 */
export function tvFaceOneFilePackUrl(color: TVFacePackSkin, state: string): string | null {
  const key: TVFacePackSkin = color === "default" ? "default" : color;
  const isDefaultFamily = key === "orange" || key === "default";

  // Pure thinking uses the denser thinking pack on the default family.
  if (state === "thinking") {
    if (isDefaultFamily) {
      const thinking = packUrl(THINKING_PACK[key]);
      if (thinking) return thinking;
    }
    // Non-default colors: multi-GIF keeps a dedicated thinking expression.
    return null;
  }

  // Expanded-only states on thin color shells would collapse to `*`; fall back.
  if (EXPANDED_DEFAULT_ONLY_STATES.has(state) && !isDefaultFamily) {
    return null;
  }

  return packUrl(PRIMARY_PACK[key]);
}

/** Public path helper for tests and docs. */
export function tvFacePackPublicPath(basename: string): string {
  return `${PACK_BASE}/${basename}`;
}
