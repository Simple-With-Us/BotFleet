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
const PRIMARY_PACK: Readonly<Partial<Record<TVFacePackSkin, string>>> = {
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
};

/** Thinking-focused pack (enter/hold/return denser).  Optional per color. */
const THINKING_PACK: Readonly<Partial<Record<TVFacePackSkin, string>>> = {
  orange: "tvface-thinking.webp",
  default: "tvface-thinking.webp",
};

/** Bot states that prefer the thinking pack when one is registered. */
const THINKING_PACK_STATES: ReadonlySet<string> = new Set([
  "thinking",
  "working",
  "computer",
  "tools",
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

  if (THINKING_PACK_STATES.has(state)) {
    const thinking = packUrl(THINKING_PACK[key]);
    if (thinking) return thinking;
  }

  return packUrl(PRIMARY_PACK[key]);
}

/** Public path helper for tests and docs. */
export function tvFacePackPublicPath(basename: string): string {
  return `${PACK_BASE}/${basename}`;
}
