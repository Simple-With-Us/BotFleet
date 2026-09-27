// The sleeping parts of a sidebar thread row.
//
// Sidebar.tsx is a monolith and its thread row is wired to the store, drag
// and drop, and a context menu, so nothing in it can be rendered on its own.
// These two pieces can: they take what they draw as props and hold no state,
// which is what lets a renderer test assert on the badge and the wake button
// rather than on the source text of a component it cannot mount.  Upstream
// splits the whole row out (`src/components/SidebarThreadRow.tsx`); this is
// the narrow slice of that split the snooze actually needs.
import { BellOff, Moon } from "lucide-react";

import { isThreadSnoozed, snoozeLabel } from "@/lib/thread-snooze";

/** The one line a sleeping row says about itself: a moon, then "until
 * activity" or the resolved deadline.  Null while the thread is awake, so
 * the caller renders it unconditionally and this decides.
 *
 * `now` is a parameter rather than a clock reading inside, because the row
 * above re-renders when the nearest deadline passes and both have to agree
 * on which side of it they are. */
export function ThreadSnoozeBadge({
  threadId,
  snoozedUntil,
  now,
}: {
  threadId: string;
  snoozedUntil?: number;
  now?: number;
}) {
  if (!isThreadSnoozed(snoozedUntil, now)) return null;
  return (
    <span
      data-thread-snoozed={threadId}
      className="flex shrink-0 items-center gap-1 text-[11px] text-ink-secondary"
    >
      <Moon size={11} aria-hidden="true" />
      {snoozeLabel(snoozedUntil, now) ?? "snoozed"}
    </span>
  );
}

/** One tap back to loud.  A SIBLING of the row rather than a child of it:
 * the row is a button, and a button inside a button is neither valid markup
 * nor reachable by keyboard — the same reason the thread disclosure arrow
 * sits outside its row. */
export function ThreadWakeButton({ label, onWake }: { label: string; onWake: () => void }) {
  return (
    <button
      type="button"
      onClick={onWake}
      title={`Wake ${label}`}
      aria-label={`Stop snoozing ${label}`}
      className="shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised/50 hover:text-ink"
    >
      <BellOff size={12} aria-hidden="true" />
    </button>
  );
}
