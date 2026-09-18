/** How the workspace is laid out.  Bots, rooms, and tasks stay the same
 * records; this setting changes what the roster is for.
 *
 * - `simple` — Grok-style.  Named bots, one conversation each.  Rooms are
 *   group threads: one shared conversation per room that invited bots and
 *   the user write in.  Extra bot tasks stay saved but stay hidden.
 * - `projects` — Claude / Codex / Antigravity style.  No named bots.  The
 *   same custom room word is a category, and any number of threads can sit
 *   under it.  Each thread can carry its own model and fallbacks.
 *   Incoming webhooks, resource samples, and schedules each reuse one
 *   thread of that type per category.
 *
 * They are not the same feature with two labels.  The room-terminology
 * setting only names them (Channel, Group, Project, or a custom pair).
 *
 * Absent on disk means `simple`.  A leftover `fleet` value from an earlier
 * draft is read as `projects`.
 */

export const CONVERSATION_MODES = ["simple", "projects"] as const;
export type ConversationMode = (typeof CONVERSATION_MODES)[number];
/** On-disk values.  `fleet` is a retired draft and is read as `projects`. */
export const STORED_CONVERSATION_MODES = ["simple", "projects", "fleet"] as const;
export const DEFAULT_CONVERSATION_MODE: ConversationMode = "simple";

export function isConversationMode(value: unknown): value is ConversationMode {
  return value === "simple" || value === "projects";
}

export function parseConversationMode(value: unknown): ConversationMode {
  if (value === "fleet") return "projects";
  return isConversationMode(value) ? value : DEFAULT_CONVERSATION_MODE;
}

/** Extra conversations per bot, and extra conversations per room, are on. */
export function allowsMultipleBotThreads(mode: ConversationMode): boolean {
  return mode === "projects";
}

export function rosterPrimaryLabel(mode: ConversationMode): {
  singular: string;
  plural: string;
  newLabel: string;
} {
  if (mode === "projects") {
    // Projects paints each bot as a thread, but the create control still
    // mints a bot record, so it names what it makes.  A thread under an
    // existing bot is added from that chat's own thread bar.
    return { singular: "Thread", plural: "Threads", newLabel: "New Bot" };
  }
  return { singular: "Bot", plural: "Bots", newLabel: "New Bot" };
}

/** What a room is in this mode: a shared group thread, or a category. */
export function roomRole(mode: ConversationMode): "group-thread" | "category" {
  return mode === "projects" ? "category" : "group-thread";
}

export function groupingNewLabel(mode: ConversationMode, roomSingular: string): string {
  return mode === "projects" ? `New ${roomSingular}` : `New ${roomSingular}`;
}

/** Titles for automation lanes in Projects mode.  Simple writes every
 * event into the bot's one conversation and never mints these. */
export function automationLaneTitle(
  mode: ConversationMode,
  source?: "schedule" | "manual" | "webhook" | "resource",
): string {
  if (mode === "projects") {
    if (source === "webhook") return "Webhooks";
    if (source === "resource") return "Resources";
    return "Schedules";
  }
  return source === "webhook" || source === "resource" ? "Triggers" : "Routines";
}

export const CONVERSATION_MODE_COPY: Record<
  ConversationMode,
  { title: string; subtitle: string }
> = {
  simple: {
    title: "Simple",
    subtitle:
      "Named bots with one conversation each, plus group threads that invited bots and you can all write in.",
  },
  projects: {
    title: "Projects",
    subtitle:
      "Categories with any number of threads under them.  Each thread picks a model.  Named bots stay hidden.",
  },
};
