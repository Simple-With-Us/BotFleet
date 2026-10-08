import { BotState } from "@/lib/mascot";

/**
 * TV-Face expression vocabulary.
 *
 * Includes every face from the TV-Face expression sheet that we ship art for
 * (stills and/or GIFs), so a bot can be driven onto a super-specific face
 * (git, webhook, orbit, sneaking, …) without being remapped away to a
 * generic stand-in. Keep in lockstep with ios/App/TVFaceManifest.swift.
 */
export type TVFaceExpression =
  | "resting" | "sleeping" | "waking" | "listening" | "thinking"
  | "searching" | "working" | "happy" | "excited" | "celebrate"
  | "confused" | "curious" | "sad" | "alerting" | "angry" | "scared"
  | "loading" | "sending" | "receiving" | "notifying" | "typing"
  | "speaking" | "powering_down" | "fleet" | "crash" | "memory"
  | "tools" | "routine" | "screen" | "git" | "webhook" | "computer"
  | "surprised" | "suspicious" | "shy" | "bored" | "drowsy"
  | "proud" | "playful" | "laughing"
  // Sheet faces that previously only existed as stills / aliases:
  | "orbit" | "progress" | "radar" | "uploading" | "sneaking"
  | "spawning";

/**
 * BotState → expression. Prefer a 1:1 map whenever a sheet face exists so the
 * bot can show the exact face the owner expects (orbit stays orbit, not fleet;
 * radar stays radar, not searching; uploading stays uploading, not sending).
 * Only collapse when no distinct art ships.
 */
export const TVFACE_MANIFEST: Record<BotState, TVFaceExpression> = {
  // Lifecycle
  sleeping: "sleeping",
  waking: "waking",
  idle: "resting",
  listening: "listening",
  thinking: "thinking",
  searching: "searching",
  working: "working",

  // Reactions — sheet emotions, 1:1
  excited: "excited",
  surprised: "surprised",
  suspicious: "suspicious",
  angry: "angry",
  drowsy: "drowsy",
  happy: "happy",
  curious: "curious",
  confused: "confused",
  bored: "bored",
  proud: "proud",
  shy: "shy",
  sad: "sad",
  laughing: "laughing",
  scared: "scared",
  playful: "playful",
  celebrate: "celebrate",

  // Bot morphs — keep sheet faces distinct
  orbit: "orbit",
  radar: "radar",
  progress: "progress",

  // Product cycle
  spawning: "spawning",
  humming: "working",
  loading: "loading",
  dictating: "speaking",
  writing: "typing",
  sending: "sending",
  receiving: "receiving",
  uploading: "uploading",
  notifying: "notifying",
  alerting: "alerting",
  dragging: "screen",
  bouncing: "excited",
  "powering-down": "powering_down",

  // Grok Actions — the super-specific faces from the sheet
  fleet: "fleet",
  crash: "crash",
  memory: "memory",
  tools: "tools",
  routine: "routine",
  screen: "screen",
  git: "git",
  webhook: "webhook",
  computer: "computer",
  typing: "typing",
  speaking: "speaking",
  sneaking: "sneaking",
};

/** Expressions that ship enter + hold + return GIFs (1s bookend contract). */
export const TVFACE_HAS_ENTER_RETURN: Set<TVFaceExpression> = new Set([
  "listening", "thinking", "typing", "speaking", "computer",
  "fleet", "crash", "memory", "tools", "routine", "screen", "git", "webhook",
]);

/**
 * Every expression name that appears on the TV-Face sheet and that the player
 * can select. Used by demos and tests so the sheet cannot silently shrink.
 */
export const TVFACE_SHEET_EXPRESSIONS: readonly TVFaceExpression[] = [
  "alerting", "angry", "bored", "celebrate", "computer", "confused",
  "crash", "curious", "drowsy", "excited", "fleet", "git",
  "happy", "laughing", "listening", "loading", "memory", "notifying",
  "orbit", "playful", "powering_down", "progress", "proud", "radar",
  "receiving", "resting", "routine", "sad", "scared", "screen",
  "searching", "sending", "shy", "sleeping", "sneaking", "spawning",
  "speaking", "suspicious", "surprised", "thinking", "tools", "typing",
  "uploading", "waking", "webhook", "working",
] as const;
