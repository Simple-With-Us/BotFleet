/** Workspace arrangement as four INDEPENDENT axes.
 *
 * `conversationMode` (`shared/conversation-mode.ts`) is one enum that has been
 * asked to answer four unrelated questions at once: what the sidebar lists,
 * how many conversations a bot may hold, how a thread maps to a working
 * directory, and what a room word means.  That conflation is why the retired
 * `fleet` draft is still sitting in the on-disk enum: adding a mode meant
 * re-deciding all four axes at the same time.
 *
 * This module splits them.  Nothing here changes behaviour on its own — it
 * resolves the four axes, defaulting each one to whatever `conversationMode`
 * implies, so an install with nothing persisted behaves EXACTLY as it does
 * today.  Call sites migrate one axis at a time.
 *
 * Axes:
 * - `roster`      — what the sidebar lists: named bots, or threads.
 * - `fanOut`      — how many conversations a bot may hold.  `parallel` is NOT
 *                   here yet: the runtime enforces one turn per bot across both
 *                   engines (`bot.busy`, server/index.ts) and a single
 *                   `inflightThreadId` crash marker, so honouring it would be
 *                   a lie until execution ownership is rebuilt.
 * - `workspace`   — how a thread maps to a working directory.  A worktree
 *                   isolates the working tree; databases, ports, browser
 *                   sessions, and deploys are isolated by the APP, not the
 *                   worktree.  Those are two different mechanisms and the
 *                   `lease` policy is the honest name for the first of them.
 *
 * `terminology` is deliberately absent: the room word is already an
 * independent setting and must never gate layout.
 */

/** What the sidebar lists. */
export const ROSTER_KINDS = ["bots", "threads"] as const;
export type RosterKind = (typeof ROSTER_KINDS)[number];

/** How many conversations one bot may hold. */
export const FAN_OUT_MODES = ["single", "per-room"] as const;
export type FanOutMode = (typeof FAN_OUT_MODES)[number];

/** How a thread binds to a working directory. */
export const WORKSPACE_POLICIES = [
  /** Threads share the bot's folder, as they do today. */
  "shared-cwd",
  /** Each task gets its own git worktree. */
  "worktree-per-task",
  /** Each task holds an exclusive lease on a directory; dispatch refuses a second. */
  "lease",
] as const;
export type WorkspacePolicy = (typeof WORKSPACE_POLICIES)[number];

export interface WorkspaceSettings {
  roster: RosterKind;
  fanOut: FanOutMode;
  workspace: WorkspacePolicy;
}

/** What the runtime actually implements today.  The UI must not offer an axis
 * the runtime will silently ignore — a setting that does nothing is worse than
 * no setting, because the user believes it changed. */
export const HONORED_AXES = {
  roster: true,
  fanOut: true,
  workspace: false,
} as const satisfies Record<keyof WorkspaceSettings, boolean>;

export function isRosterKind(value: unknown): value is RosterKind {
  return value === "bots" || value === "threads";
}

export function isFanOutMode(value: unknown): value is FanOutMode {
  return value === "single" || value === "per-room";
}

export function isWorkspacePolicy(value: unknown): value is WorkspacePolicy {
  // NOT `value === WORKSPACE_POLICIES.find(p => p === value)`: `find` returns
  // undefined for an unknown value, and `undefined === undefined` is true, so
  // that form silently accepted every value that was not in the list.
  return value === "shared-cwd" || value === "worktree-per-task" || value === "lease";
}

/** The three arrangements Jay described, expressed as axis presets.
 *
 * `app-teams` is C's ORGANIZATION only.  Its concurrency is deliberately not
 * a fifth `fanOut` value: until execution ownership supports two live threads
 * per bot, C is "one stable home per bot per app, worked one at a time". */
export const ARRANGEMENT_PRESETS = {
  /** A: a team of bots.  One conversation each, plus group threads. */
  "bot-team": { roster: "bots", fanOut: "single", workspace: "shared-cwd" },
  /** B: bots collaborate in the app room, taking turns. */
  "shared-apps": { roster: "bots", fanOut: "per-room", workspace: "shared-cwd" },
  /** C: a stable home per bot per app. */
  "app-teams": { roster: "bots", fanOut: "per-room", workspace: "lease" },
} as const satisfies Record<string, WorkspaceSettings>;

export type ArrangementPreset = keyof typeof ARRANGEMENT_PRESETS;

export const ARRANGEMENT_IDS = Object.keys(ARRANGEMENT_PRESETS) as ArrangementPreset[];

export function isArrangementPreset(value: unknown): value is ArrangementPreset {
  return typeof value === "string" && value in ARRANGEMENT_PRESETS;
}

/** What each retired `conversationMode` implies, axis by axis.  These are the
 * exact values that make the split a no-op for an install that persists
 * nothing new. */
export function legacyAxesFor(mode: "simple" | "projects"): WorkspaceSettings {
  return mode === "projects"
    ? { roster: "threads", fanOut: "per-room", workspace: "shared-cwd" }
    : { roster: "bots", fanOut: "single", workspace: "shared-cwd" };
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = legacyAxesFor("simple");

/** Resolve the four axes from a partial persisted record.
 *
 * Each axis falls back INDEPENDENTLY, so a record that persisted only `roster`
 * keeps today's `fanOut` and `workspace` rather than snapping the whole
 * install back to a mode preset.  This is what lets the settings land one axis
 * at a time without a migration that has to guess. */
export function resolveWorkspaceSettings(
  persisted: Partial<Record<keyof WorkspaceSettings, unknown>> | undefined | null,
  legacyMode: "simple" | "projects",
): WorkspaceSettings {
  const fallback = legacyAxesFor(legacyMode);
  // Read each axis into a local first.  A type guard applied to
  // `persisted?.roster` narrows `persisted` itself in TypeScript's view, which
  // lets a null record through to a bare `persisted.workspace` and throw.
  const roster = persisted?.roster;
  const fanOut = persisted?.fanOut;
  const workspace = persisted?.workspace;
  return {
    roster: isRosterKind(roster) ? roster : fallback.roster,
    fanOut: isFanOutMode(fanOut) ? fanOut : fallback.fanOut,
    workspace: isWorkspacePolicy(workspace) ? workspace : fallback.workspace,
  };
}

/** Drop axes the runtime does not honour yet, so a persisted value can never
 * imply a behaviour that does not exist. */
export function effectiveWorkspaceSettings(
  settings: WorkspaceSettings,
): WorkspaceSettings {
  return {
    roster: settings.roster,
    fanOut: settings.fanOut,
    workspace: HONORED_AXES.workspace ? settings.workspace : "shared-cwd",
  };
}

/** The legacy view of a resolved record, so the 88 existing call sites can be
 * migrated one at a time instead of all at once. */
export function conversationModeFor(settings: WorkspaceSettings): "simple" | "projects" {
  return settings.roster === "threads" ? "projects" : "simple";
}
