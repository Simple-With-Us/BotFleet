/** How the workspace is laid out.  Bots, rooms, and tasks stay the same
 * records; this setting changes what the roster is for.
 *
 * - `simple` — Grok-style.  Named bots, one conversation each.  Rooms are
 *   group threads: one shared conversation per room that invited bots and
 *   the user write in.  Extra threads left over from Projects stay saved and
 *   out of the sidebar, unless merging them was chosen when switching to
 *   Simple.
 * - `projects` — Claude / Codex / Antigravity style.  Bots stay in the
 *   roster, which is headed Threads, and each bot and each room can hold
 *   any number of threads, nested under it in the sidebar.  A bot thread
 *   can be tied to one room (its App) and runs in that room's folder.
 *   Incoming webhooks, resource samples, and schedules write into the bot's
 *   open thread in both arrangements.  Projects also keeps sending a source
 *   to a thread that already carries its key.
 *
 * Projects does not hide bots.  The server honors a per-thread model, but no
 * shipped client can set one, so the Settings copy does not promise it.
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
  source?: "schedule" | "manual" | "webhook" | "resource" | "delegation" | "imessage",
): string {
  if (mode === "projects") {
    if (source === "webhook") return "Webhooks";
    if (source === "resource") return "Resources";
    return "Schedules";
  }
  return source === "webhook" || source === "resource" ? "Triggers" : "Routines";
}

/** What each arrangement says about itself in Settings.  A subtitle takes the
 * person's own singular room word, already lowercased, so a workspace that
 * calls rooms channels never reads "room".  Neither subtitle may promise
 * hidden bots or a per-thread model:  Projects lists bots as Simple does, and
 * no shipped client sets a thread's model. */
export const CONVERSATION_MODE_COPY: Record<
  ConversationMode,
  { title: string; subtitle: (room: string) => string }
> = {
  simple: {
    title: "Simple",
    subtitle: () =>
      "Named bots with one conversation each, plus group threads that invited bots and you can all write in.",
  },
  projects: {
    title: "Projects",
    subtitle: (room) =>
      `Any number of threads under each bot and ${room}, nested in the sidebar.\u00a0 A thread can be tied to one ${room}.`,
  },
};
