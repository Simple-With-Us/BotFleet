import { CURSOR_STATES, type CursorState } from "@/components/CursorAvatar";

/** The mascot's behaviour vocabulary — CursorAvatar's 39 states, under the
 * app's historical names. */
export const GROK_ACTIONS = [
  "fleet",
  "crash",
  "memory",
  "tools",
  "routine",
  "screen",
  "git",
  "webhook",
  "computer",
  "typing",
  "speaking",
  "sneaking",
] as const;

export type BotState = CursorState | typeof GROK_ACTIONS[number];
export const BOT_STATES: BotState[] = [...CURSOR_STATES, ...GROK_ACTIONS];

/** CursorAvatar ships French group labels; the app shows these instead. The
 * memberships mirror its STATE_GROUPS exactly. */
export const STATE_GROUPS: Record<string, BotState[]> = {
  Lifecycle: ["sleeping", "waking", "idle", "listening", "thinking", "searching", "working"],
  Reactions: [
    "excited",
    "surprised",
    "suspicious",
    "angry",
    "drowsy",
    "happy",
    "curious",
    "confused",
    "bored",
    "proud",
    "shy",
    "sad",
    "laughing",
    "scared",
    "playful",
    "celebrate",
  ],
  "Bot morphs": ["orbit", "radar", "progress"],
  "Product cycle": [
    "spawning",
    "humming",
    "loading",
    "dictating",
    "writing",
    "sending",
    "receiving",
    "uploading",
    "notifying",
    "alerting",
    "dragging",
    "bouncing",
    "powering-down",
  ],
  "Actions": [
    "fleet",
    "crash",
    "memory",
    "tools",
    "routine",
    "screen",
    "git",
    "webhook",
    "computer",
    "typing",
    "speaking",
    "sneaking",
  ],
};

export function mapBotStateToCursorState(state: BotState): CursorState {
  const map: Record<string, CursorState> = {
    fleet: "orbit",
    crash: "scared",
    memory: "searching",
    tools: "working",
    routine: "progress",
    screen: "searching",
    git: "working",
    webhook: "sending",
    computer: "working",
    typing: "writing",
    speaking: "dictating",
  };
  return (map[state] as CursorState) || (state as CursorState);
}

/** CursorAvatar-only fallback when a BotState has TV-Face art but no Cursor pool. */
export function mapBotStateToCursorAvatarState(state: BotState): CursorState {
  if (state === "sneaking") return "playful";
  return mapBotStateToCursorState(state);
}

export const BOT_COLOR_NAMES = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
  "white",
  "black",
] as const;

export type BotColor = (typeof BOT_COLOR_NAMES)[number];

export const BOT_COLORS = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#E78531",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
  white: "#E8EAED",
  black: "#2D3036",
} satisfies Record<BotColor, string>;

export const BOT_MOTIONS = [
  "arrive",
  "switch",
  "customize",
  "alert",
  "thinking",
  "working",
  "launch",
  "success",
  "celebrate",
  "blink",
  "surprise",
  "failure",
] as const;

export type BotMotion = "none" | (typeof BOT_MOTIONS)[number];

/**
 * The face used to be ten hand-drawn SVGs; it is now the engine's 39 states.
 * Bots saved under the old vocabulary still carry one of these ten names, so
 * they are translated on read rather than migrated in place — a bot's stored
 * face should survive a downgrade too.
 */
interface LegacyStates {
  [state: string]: BotState;
}

const LEGACY_STATES: LegacyStates = {
  deadpan: "idle",
  friendly: "happy",
  focused: "working",
  thinking: "thinking",
  excited: "excited",
  sleepy: "drowsy",
  surprised: "surprised",
  skeptical: "suspicious",
  worried: "scared",
  mischievous: "playful",
};

const KNOWN_STATES = new Set<string>(BOT_STATES);

/** Resolves any stored value — current, legacy or junk — to a real state. */
export function normalizeState(value: string | null | undefined): BotState | null {
  if (!value) return null;
  if (KNOWN_STATES.has(value)) return value as BotState;
  return LEGACY_STATES[value] ?? null;
}

/**
 * The states worth offering in the appearance picker.
 *
 * The engine carries 39, but many are transient beats the app drives itself
 * (`sending`, `alerting`, `powering-down`) and make no sense as a bot's resting
 * face. More importantly, states share resting faces: `happy`, `excited` and
 * `playful` all rest on expression 2, and `curious`, `surprised` and `scared`
 * all rest on 3 — they differ in which faces they *drift* to, which a static
 * swatch cannot show. Offering them all gave 15 buttons showing 8 pictures.
 *
 * Across all 39 states there are only 11 distinct resting faces, so this is one
 * state per face, chosen for the clearest name. Every swatch looks different.
 */
export const PICKABLE_STATES: BotState[] = [
  "idle", // expression 0
  "happy", // 2
  "curious", // 3
  "drowsy", // 4
  "working", // 7
  "thinking", // 8
  "listening", // 10
  "sleeping", // 13
  "suspicious", // 14
  "proud", // 15
];

type MascotMessage = {
  kind: string;
  tool?: { ok?: boolean };
};

export type MascotBotProfile = {
  name: string;
  title?: string;
  description?: string;
  mascotExpression?: string | null;
  busy?: boolean;
  unread?: boolean;
  messages?: MascotMessage[];
};

/**
 * Role tiers, most specific first.  The first tier with a whole-word match
 * wins.  The iOS app (`ios/App/MascotState.swift`) carries the same tiers in
 * the same order, and `mascot.test.ts` fails if the two drift, so a bot wears
 * the same face on the phone as on the laptop.  Keywords are whole words, so
 * list every form that should match (`orchestrator`, not a stem).
 */
export const ROLE_TIERS: ReadonlyArray<readonly [BotState, readonly string[]]> = [
  // Super-specific TV-Face sheet faces when the role is clear.
  ["git", ["git", "github", "pull request", "pr", "commit", "merge", "deploy", "compiler", "build", "ci", "testflight"]],
  ["webhook", ["webhook", "hooks", "callback", "event stream"]],
  ["fleet", ["fleet", "director", "coordinator", "orchestrator", "orchestration", "orchestrate"]],
  ["sneaking", ["sneak", "stealth", "quiet"]],
  ["memory", ["memory", "rag", "vector", "embedding", "recall"]],
  ["tools", ["tool", "tools", "adapter", "plumber", "connector", "skill"]],
  ["computer", ["computer", "desktop", "shell", "terminal", "ssh"]],
  ["routine", ["routine", "schedule", "cron", "recurring", "housekeeper"]],
  ["screen", ["screen", "ui", "ux", "designer", "frontend"]],
  ["crash", ["crash", "sentry", "pagerduty", "fixer", "incident response"]],
  ["working", ["code", "coding", "developer", "development", "engineer", "engineering", "debug", "program", "software"]],
  ["searching", ["research", "researcher", "search", "investigate", "strategy", "strategist", "study", "learn", "knowledge"]],
  ["excited", ["marketing", "growth", "launch", "campaign", "social", "sales", "outreach", "brand"]],
  ["drowsy", ["overnight", "night", "background", "async", "queue", "batch", "long-running"]],
  ["radar", ["monitor", "monitoring", "incident", "alert", "watch", "status", "uptime"]],
  ["suspicious", ["review", "reviewer", "audit", "critic", "critique", "quality", "qa", "test", "legal", "publisher"]],
  ["scared", ["security", "secure", "compliance", "risk", "privacy", "finance", "financial"]],
  ["playful", ["design", "creative", "brainstorm", "art", "illustration", "music", "story"]],
  ["happy", ["support", "help", "success", "onboarding", "coach", "teacher", "guide", "welcome"]],
];

const escapeRegExp = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ROLE_MATCHERS = ROLE_TIERS.map(
  ([state, words]) => [state, new RegExp(`\\b(?:${words.map(escapeRegExp).join("|")})\\b`)] as const,
);

/**
 * Selects a state from live state first, then from what the bot is about.
 */
export function stateForBot(bot: MascotBotProfile): BotState {
  const pinned = normalizeState(bot.mascotExpression);
  if (pinned) return pinned;

  const last = bot.messages?.[bot.messages.length - 1];

  if (last?.kind === "activity" && last.tool?.ok === false) return "alerting";
  if (bot.busy) return "working";
  if (bot.unread) return "notifying";
  if (last?.kind === "options") return "curious";

  const profile = `${bot.name} ${bot.title ?? ""} ${bot.description ?? ""}`.toLowerCase();
  for (const [state, pattern] of ROLE_MATCHERS) {
    if (pattern.test(profile)) return state;
  }
  return "idle";
}


/**
 * The state a bot is drawn in, once the speech is taken into account.
 *
 * A bot that is speaking is drawn as speaking, whatever else it is doing,
 * because a moving mouth is the thing a listener is watching.  Only the bot
 * whose voice is playing changes, and only while the voice is playing.  A bot
 * that is not speaking keeps the state it was given, which is what every
 * other state in the app is built on.
 *
 * `speakingBotId` is the bot whose voice is playing, or undefined when no
 * voice is.  It is a narrow value on purpose: the speech snapshot is
 * replaced on every caption, and a component that read all of it re-rendered
 * on every line of a spoken reply.
 */
export function stateWithSpeech(
  state: BotState | undefined,
  speakingBotId: string | undefined,
  botId: string | undefined,
): BotState | undefined {
  if (!botId) return state;
  if (speakingBotId !== botId) return state;
  return "speaking";
}

/** @deprecated Temporary aliases during the Maus → Bot rebrand. Prefer Bot*. */
export type MausColor = BotColor;
export type MausState = BotState;
export type MausMotion = BotMotion;
export const MAUS_COLORS = BOT_COLORS;
export const MAUS_COLOR_NAMES = BOT_COLOR_NAMES;
export const MAUS_STATES = BOT_STATES;
export const MAUS_MOTIONS = BOT_MOTIONS;
