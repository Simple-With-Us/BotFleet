import { CircleAlert } from "lucide-react";

import {
  summarizeTriggerAttention,
  triggerAcknowledgeTitle,
  triggerAttentionKeyFor,
  triggerErrorBadgeLabel,
  type TriggerAttention,
} from "@/lib/routine-attention";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/use-now";
import { useStore } from "@/state/store";

/** Per-trigger error count, acknowledgeable in one click.
 *
 *  The header badge says how much is broken fleet-wide; this says which
 *  trigger is the one, next to the trigger's own name.  A webhook failing
 *  every minute and four hundred stale failures from last month are the same
 *  number in the header total, and only one of them is worth acting on now.
 *
 *  Clicking acknowledges: the runs keep their status, error, and history, the
 *  badge clears, and the next failure raises it again.  No confirm dialog,
 *  because nothing is lost — but the tooltip says so out loud, since a badge
 *  that silently swallows a count is its own kind of untrustworthy number. */
export function TriggerErrorBadge({ triggerId, name, source, className }: {
  triggerId: string;
  name: string;
  source: "webhook" | "resource";
  className?: string;
}) {
  const { state, dispatch } = useStore();
  // The hour and day windows derive from the clock, so the badge needs the
  // same ticking dependency the page-level summary uses, or it goes stale
  // while the panel sits open.
  const now = useNow();
  const attention: TriggerAttention | undefined = summarizeTriggerAttention(state.routineRuns, now)
    .get(triggerAttentionKeyFor(source, triggerId));
  if (!attention || attention.total === 0) return null;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        dispatch({ type: "acknowledgeTriggerAttention", triggerId, triggerSource: source });
      }}
      title={triggerAcknowledgeTitle(name, attention)}
      aria-label={triggerAcknowledgeTitle(name, attention)}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border border-danger/25 bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger hover:bg-danger/20",
        className,
      )}
    >
      <CircleAlert size={10} />
      {triggerErrorBadgeLabel(attention)}
    </button>
  );
}
