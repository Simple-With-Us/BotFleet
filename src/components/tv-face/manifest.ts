import { BotState } from "@/lib/mascot";

/**
 * The 15 expressions the pre-rendered pack ships, single-sourced.
 *
 * The list was previously stated three different ways: 39 in a code comment,
 * 40 in the union type, and 41 in AVATAR-PACKAGING-GUIDELINES.md. It is now
 * derived from this array, so it cannot drift a fourth time.
 *
 * ASSET NAMES ARE THE CONTRACT. `public/tv-face/skins/<skin>/gifs/` must
 * contain `<expression>_enter.gif`, `<expression>_hold.gif` and
 * `<expression>_return.gif` for each entry below, and
 * `stills/<expression>.png`. Renaming an expression here renames its assets;
 * the pack currently on disk was generated against the old 40-name union and
 * must be regenerated before this ships.
 */
export const TVFACE_EXPRESSIONS = [
  // 6 identity — what the bot looks like at rest
  "resting",
  "sleeping",
  "listening",
  "happy",
  "proud",
  "sad",
  // 6 activity — the only things that may animate the body
  "working",
  "thinking",
  "searching",
  "speaking",
  "waiting",
  "error",
  // 3 reactions — short accents layered on top, never a competing body loop
  "celebrate",
  "curious",
  "alert",
] as const;

export type TVFaceExpression = (typeof TVFACE_EXPRESSIONS)[number];

export const RESTING: TVFaceExpression = "resting";

/** Every expression ships all three animations, so this is derived rather than
 * hand-listed. It used to be a hardcoded 13-entry Set, which meant any
 * expression added later silently lost its enter and return. */
export const TVFACE_HAS_ENTER_RETURN: ReadonlySet<TVFaceExpression> = new Set(
  TVFACE_EXPRESSIONS,
);

/**
 * How long the enter and return animations are assumed to run.
 *
 * This was a bare 1000 inline. It is now named because it is a contract with
 * the asset pack, not a rendering detail: a correctly generated ~600ms enter
 * freezes on its last frame for the remainder. Whoever regenerates the pack
 * must hold enter/return to this duration, or this must be read from the GIF.
 */
export const TVFACE_TRANSITION_MS = 1000;

/**
 * Every BotState resolves to one of the 15, so a bot's persisted
 * `mascotExpression` keeps resolving after the cut. Dropped states are
 * aliased onto the nearest survivor rather than deleted.
 */
export const TVFACE_MANIFEST: Record<BotState, TVFaceExpression> = {
  // Lifecycle
  idle: "resting",
  sleeping: "sleeping",
  waking: "working",
  listening: "listening",
  thinking: "thinking",
  searching: "searching",
  working: "working",

  // Reactions
  excited: "celebrate",
  surprised: "curious",
  suspicious: "curious",
  angry: "alert",
  drowsy: "sleeping",
  happy: "happy",
  curious: "curious",
  confused: "curious",
  bored: "resting",
  proud: "proud",
  shy: "curious",
  sad: "sad",
  laughing: "happy",
  scared: "alert",
  playful: "curious",
  celebrate: "celebrate",

  // Bot morphs
  orbit: "speaking",
  radar: "searching",
  progress: "working",

  // Product cycle
  spawning: "working",
  humming: "working",
  loading: "working",
  dictating: "speaking",
  writing: "working",
  sending: "working",
  receiving: "working",
  uploading: "working",
  notifying: "alert",
  alerting: "alert",
  dragging: "working",
  bouncing: "celebrate",
  "powering-down": "resting",

  // Actions (Grok)
  fleet: "speaking",
  crash: "error",
  memory: "searching",
  tools: "working",
  routine: "working",
  screen: "working",
  git: "working",
  webhook: "working",
  computer: "working",
  typing: "working",
  speaking: "speaking",
};
