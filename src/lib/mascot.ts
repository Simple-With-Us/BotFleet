import { CURSOR_STATES, type CursorState } from "@/components/CursorAvatar";

/** The mascot's behaviour vocabulary — CursorAvatar's 39 states, under the
 * app's historical names. */
export type BotState = CursorState;
export const BOT_STATES = CURSOR_STATES;

/** CursorAvatar ships French group labels; the app shows these instead. The
 * memberships mirror its STATE_GROUPS exactly. */
export const STATE_GROUPS = {
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
} satisfies Record<string, BotState[]>;

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
 * Selects a state from live state first, then from what the bot is about.
 * The keyword groups deliberately overlap as little as possible so a bot's
 * visual identity stays stable while its title and description are edited.
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
  const matches = (words: RegExp) => words.test(profile);

  if (matches(/\b(code|coding|developer|development|engineer|engineering|build|debug|program|software)\b/)) {
    return "working";
  }
  if (matches(/\b(research|researcher|search|investigate|strategy|strategist|study|learn|knowledge)\b/)) {
    return "searching";
  }
  if (matches(/\b(marketing|growth|launch|campaign|social|sales|outreach|brand)\b/)) {
    return "excited";
  }
  if (matches(/\b(overnight|night|background|async|queue|batch|long-running)\b/)) {
    return "drowsy";
  }
  if (matches(/\b(monitor|monitoring|incident|alert|watch|status|uptime)\b/)) {
    return "radar";
  }
  if (matches(/\b(review|reviewer|audit|critic|critique|quality|qa|test|legal)\b/)) {
    return "suspicious";
  }
  if (matches(/\b(security|secure|compliance|risk|privacy|finance|financial)\b/)) {
    return "scared";
  }
  if (matches(/\b(design|designer|creative|brainstorm|art|illustration|music|story)\b/)) {
    return "playful";
  }
  if (matches(/\b(support|help|success|onboarding|coach|teacher|guide|welcome)\b/)) {
    return "happy";
  }

  return "idle";
}


/** @deprecated Temporary aliases during the Maus → Bot rebrand. Prefer Bot*. */
export type MausColor = BotColor;
export type MausState = BotState;
export type MausMotion = BotMotion;
export const MAUS_COLORS = BOT_COLORS;
export const MAUS_COLOR_NAMES = BOT_COLOR_NAMES;
export const MAUS_STATES = BOT_STATES;
export const MAUS_MOTIONS = BOT_MOTIONS;
