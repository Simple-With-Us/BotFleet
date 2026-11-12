// What a chat or a room says while an update is holding new work.
//
// A message sent during that window is accepted and kept: the bot's queue (or
// the room's) holds it, and it runs after the restart.  Nothing else on the
// screen changes, so a bot looks stuck and a room goes quiet.  This is the
// line that says why, and when the restart begins.  Silent when no update is
// holding anything, including against an older harness that never says.
//
// The words live in src/lib/update-control.ts (`drainNoticeCopy`); the view is
// props-only so it can be rendered without a harness.
import { RefreshCw } from "lucide-react";

import { drainNoticeCopy, useNow, useUpdateDrain, type UpdateDrain } from "@/lib/update-control";

export function UpdateDrainNoticeView({ drain, now }: { drain: UpdateDrain | null; now: number }) {
  // A hold past its lease is a harness that went away mid-update, not one
  // still holding anything.
  if (!drain || now >= drain.deadline) return null;
  return (
    <div className="pointer-events-auto px-5 pb-1">
      <div
        role="status"
        aria-live="polite"
        data-testid="update-drain-notice"
        className="flex items-start gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12.5px] leading-snug text-ink-secondary"
      >
        <RefreshCw size={13} className="mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{drainNoticeCopy(drain, now)}</span>
      </div>
    </div>
  );
}

/** Mounted once above a chat's or a room's composer. */
export function UpdateDrainNotice() {
  const drain = useUpdateDrain();
  // Ticks only while there is a countdown to keep honest.
  const now = useNow(drain ? 1_000 : null);
  return <UpdateDrainNoticeView drain={drain} now={now} />;
}
