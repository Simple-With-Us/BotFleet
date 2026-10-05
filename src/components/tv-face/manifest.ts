import { BotState } from "@/lib/mascot";

export type TVFaceExpression = 
  | "resting" | "sleeping" | "waking" | "listening" | "thinking" 
  | "searching" | "working" | "happy" | "excited" | "celebrate" 
  | "confused" | "curious" | "sad" | "alerting" | "angry" | "scared"
  | "loading" | "sending" | "receiving" | "notifying" | "typing" 
  | "speaking" | "powering_down" | "fleet" | "crash" | "memory" 
  | "tools" | "routine" | "screen" | "git" | "webhook" | "computer"
  | "surprised" | "suspicious" | "shy" | "bored" | "drowsy" 
  | "proud" | "playful" | "laughing";

export const TVFACE_MANIFEST: Record<BotState, TVFaceExpression> = {
  // Lifecycle
  sleeping: "sleeping",
  waking: "waking",
  idle: "resting",
  listening: "listening",
  thinking: "thinking",
  searching: "searching",
  working: "working",
  
  // Reactions
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

  // Bot morphs
  orbit: "fleet",
  radar: "searching",
  progress: "routine",

  // Product cycle
  spawning: "waking",
  humming: "working",
  loading: "loading",
  dictating: "speaking",
  writing: "typing",
  sending: "sending",
  receiving: "receiving",
  uploading: "sending",
  notifying: "notifying",
  alerting: "alerting",
  dragging: "screen",
  bouncing: "excited",
  "powering-down": "powering_down",

  // Grok Actions
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
};

export const TVFACE_HAS_ENTER_RETURN: Set<TVFaceExpression> = new Set([
  "listening", "thinking", "typing", "speaking", "computer",
  "fleet", "crash", "memory", "tools", "routine", "screen", "git", "webhook"
]);

/**
 * Expressions that ship a looping hold GIF (`gifs/<expression>_hold.gif`) in
 * every pack under public/tv-face/skins.
 *
 * Fifteen reachable expressions ship a still only — `scared`, `sad`, `waking`,
 * `proud`, and eleven others.  The player used to ask for their hold GIF
 * anyway, 404, and fall back to that same still through `onError`, burning a
 * request on every cue.  It now asks for the still directly.  Whether an
 * expression belongs here is asserted against the on-disk packs in
 * tvFaceSkins.test.ts, so the two cannot drift.
 */
export const TVFACE_HAS_HOLD: ReadonlySet<TVFaceExpression> = new Set([
  "alerting", "angry", "computer", "crash", "excited", "fleet", "git",
  "happy", "laughing", "listening", "loading", "memory", "notifying",
  "resting", "routine", "screen", "searching", "sleeping", "speaking",
  "surprised", "thinking", "tools", "typing", "webhook", "working",
]);
