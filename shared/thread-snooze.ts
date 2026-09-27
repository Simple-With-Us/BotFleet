// Per-thread snooze — one conversation put to sleep, not the whole bot.
//
// BotFleet already snoozes a WHOLE bot (`server/routines.ts`): that stops
// routines and webhooks restarting it, and it is what "snooze bot on stop"
// (#514) leaves behind.  This is the narrower thing — one thread of one bot
// goes quiet while its siblings keep working.
//
// The two compose in one direction only.  A snoozed bot implies every thread
// under it, because nothing may wake that bot at all; waking one thread never
// wakes the bot, because the person who stopped a bot did not ask for it back.
//
// Everything here is pure and shared, so the harness (`server/store.ts`,
// `server/index.ts`, `server/notify.ts`), the sidebar (`src/components/
// Sidebar.tsx`) and the paired phone's contract all answer "is this asleep?"
// the same way, from the same clock reading.

/** Sleep until the thread does something again rather than until a moment.
 *
 * 0 is a real value on the wire, never "no snooze": absent is how awake
 * travels, which is why the API takes JSON `null` to wake a thread and
 * treats an omitted field as "leave it alone". */
export const SNOOZE_UNTIL_ACTIVITY = 0;

/** Asleep right now.  The sentinel sleeps until something wakes it; a
 * timestamp sleeps only until it passes.
 *
 * The harness drops expired snoozes from what it hands out, but a live SSE
 * frame is never refreshed afterwards, so a client that has been open across
 * the deadline has to check the clock too. */
export function isThreadSnoozed(snoozedUntil: number | undefined, now = Date.now()): boolean {
  if (snoozedUntil === undefined) return false;
  return snoozedUntil === SNOOZE_UNTIL_ACTIVITY || snoozedUntil > now;
}

/** Whether a stored snooze has nothing left to wait for, so the harness may
 * drop it.  The sentinel is not a time and never expires on a clock. */
export function isSnoozeExpired(snoozedUntil: number | undefined, now = Date.now()): boolean {
  return snoozedUntil !== undefined && snoozedUntil > SNOOZE_UNTIL_ACTIVITY && snoozedUntil <= now;
}

/** The soonest still-future deadline in a list, or undefined when nothing is
 * scheduled to wake.  A list ticks its own clock off this: the sentinel never
 * ticks, and a deadline already past has nothing left to schedule. */
export function nextSnoozeExpiry(
  snoozes: readonly (number | undefined)[],
  now = Date.now(),
): number | undefined {
  let soonest: number | undefined;
  for (const until of snoozes) {
    if (until === undefined || until <= SNOOZE_UNTIL_ACTIVITY || until <= now) continue;
    if (soonest === undefined || until < soonest) soonest = until;
  }
  return soonest;
}

/** The presets the menu offers, in the order it offers them.  "custom" is
 * the person's own moment and resolves to whatever they picked. */
export const SNOOZE_PRESETS = ["hour", "tomorrow", "activity"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

/** Sentence case, because these are values in a menu rather than headings. */
export const SNOOZE_PRESET_LABELS: Record<SnoozePreset, string> = {
  hour: "For 1 hour",
  tomorrow: "Until tomorrow morning",
  activity: "Until activity",
};

/** Tomorrow morning is 8 local.  Local on purpose: it is the person's
 * morning, and the harness stores the absolute moment either way. */
export const SNOOZE_MORNING_HOUR = 8;

/** Resolve a preset when the person picks it, never when the menu opened —
 * a menu left open overnight must not snooze until a morning that has
 * already been and gone. */
export function resolveSnoozePreset(preset: SnoozePreset, now = Date.now()): number {
  if (preset === "activity") return SNOOZE_UNTIL_ACTIVITY;
  if (preset === "hour") return now + 3_600_000;
  const when = new Date(now);
  when.setDate(when.getDate() + 1);
  when.setHours(SNOOZE_MORNING_HOUR, 0, 0, 0);
  return when.getTime();
}

/** What a custom "wake me at" input means, or undefined when it means
 * nothing.  A moment already past is not a snooze, and neither is a string
 * the date parser could not read — both come back undefined so the caller
 * refuses rather than storing a snooze that is over before it starts. */
export function resolveCustomSnooze(value: string, now = Date.now()): number | undefined {
  const at = new Date(value).getTime();
  return Number.isFinite(at) && at > now ? at : undefined;
}

/** The one line a snoozed row says about itself: "until activity", or the
 * resolved deadline as "until 8:00 am".  Null when the thread is awake, so
 * a caller can render the badge or not on this alone.
 *
 * A deadline past today carries its weekday, because "until 8:00 am" on a
 * Friday row that wakes on Monday would be a lie. */
export function snoozeLabel(snoozedUntil: number | undefined, now = Date.now()): string | null {
  if (!isThreadSnoozed(snoozedUntil, now)) return null;
  if (snoozedUntil === SNOOZE_UNTIL_ACTIVITY) return "until activity";
  const when = new Date(snoozedUntil!);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const sameDay = when.toDateString() === new Date(now).toDateString();
  return sameDay ? `until ${time}` : `until ${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** Newest activity, falling back to when the thread was created.  A missing
 * stamp sorts oldest rather than as NaN, so a half-loaded row cannot jump
 * the list. */
export function threadRecency(task: { createdAt: number; lastActivity?: number }): number {
  if (typeof task.lastActivity === "number" && Number.isFinite(task.lastActivity)) return task.lastActivity;
  return Number.isFinite(task.createdAt) ? task.createdAt : 0;
}

export interface SnoozeOrderedThread {
  threadId: string;
  createdAt: number;
  lastActivity?: number;
  snoozedUntil?: number;
}

/** Thread-list order: awake threads newest-first, then the sleeping ones.
 *
 * A snoozed thread SINKS rather than disappearing, and the moment its
 * deadline passes it is awake again and back in plain update order — nothing
 * has to remember where it used to sit, because the position was never
 * stored, only derived.
 *
 * `keepInPlace` is upstream #1248's pinned-thread retention, read literally:
 * an anchored thread is never demoted to the sleeping tier, so it holds the
 * update-order slot it already had rather than being promoted anywhere.
 * BotFleet pins bots rather than threads, so the anchor here is the thread
 * the person currently has open — snoozing the conversation you are reading
 * must not yank it out from under you.
 *
 * Stable within each tier: equal stamps keep the caller's order. */
export function orderedThreadRows<T extends SnoozeOrderedThread>(
  tasks: readonly T[],
  now = Date.now(),
  keepInPlace: ReadonlySet<string> = new Set(),
): T[] {
  const asleep = (task: T): boolean =>
    !keepInPlace.has(task.threadId) && isThreadSnoozed(task.snoozedUntil, now);
  return tasks
    .map((task, index) => ({ task, index, asleep: asleep(task) }))
    .sort((a, b) => {
      if (a.asleep !== b.asleep) return a.asleep ? 1 : -1;
      const recency = threadRecency(b.task) - threadRecency(a.task);
      return recency || a.index - b.index;
    })
    .map((entry) => entry.task);
}
