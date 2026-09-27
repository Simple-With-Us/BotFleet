// Per-thread snooze, renderer side.
//
// The rules themselves live in `shared/thread-snooze.ts` so the harness and
// the paired phone cannot drift from the sidebar.  What is here is the one
// thing only a window needs: a clock.
import { useEffect, useState } from "react";

import { nextSnoozeExpiry } from "../../shared/thread-snooze";

export {
  isThreadSnoozed,
  nextSnoozeExpiry,
  orderedThreadRows,
  resolveCustomSnooze,
  resolveSnoozePreset,
  SNOOZE_PRESET_LABELS,
  SNOOZE_PRESETS,
  SNOOZE_UNTIL_ACTIVITY,
  snoozeLabel,
  type SnoozePreset,
} from "../../shared/thread-snooze";

/** setTimeout clamps anything past 2^31-1 ms to almost zero, which would
 * turn a snooze until next month into a render loop. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Re-render when the nearest snooze deadline passes.
 *
 * A timed snooze ends on the wall clock, not on a server ping.  The harness
 * does sweep expired snoozes and broadcast the change, so this is belt to
 * that braces — but it is the half that costs nothing and cannot be late,
 * and it is what keeps a row from sitting greyed out for up to a minute
 * after its own deadline.  The until-activity sentinel never ticks: it is
 * not a time, and only activity in the thread ends it. */
export function useSnoozeExpiry(tasks: readonly { snoozedUntil?: number }[]): void {
  const [tick, rerender] = useState(0);
  const next = nextSnoozeExpiry(tasks.map((task) => task.snoozedUntil));
  useEffect(() => {
    if (next === undefined) return;
    const delay = Math.max(1, Math.min(MAX_TIMEOUT_MS, next - Date.now() + 1));
    const id = window.setTimeout(() => rerender((count) => count + 1), delay);
    return () => window.clearTimeout(id);
    // `tick` re-arms the timer for a deadline further out than one clamp.
  }, [next, tick]);
}
