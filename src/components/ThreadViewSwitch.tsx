// The Chat | Trajectory switch in a thread's header.  Not the thread tabs
// (ThreadTabs.tsx are per-task threads); this picks how the open thread is
// shown.  A pair of toggle buttons rather than ARIA tabs, so the two never
// read as one more tab strip.  Below the header's wide breakpoint the labels
// fold away and the icons carry it; the accessible names stay.
import { ChartGantt, MessageSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ThreadView } from "@/lib/thread-view";

const OPTIONS: ReadonlyArray<{ id: ThreadView; label: string; hint: string; Icon: typeof MessageSquare }> = [
  { id: "chat", label: "Chat", hint: "Show the conversation", Icon: MessageSquare },
  { id: "trajectory", label: "Trajectory", hint: "Show what the bot did and where the time went", Icon: ChartGantt },
];

export function ThreadViewSwitch({ view, onChange }: { view: ThreadView; onChange: (view: ThreadView) => void }) {
  return (
    <div role="group" aria-label="Thread View" className="flex shrink-0 rounded-lg bg-inset p-0.5">
      {OPTIONS.map(({ id, label, hint, Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          aria-label={label}
          title={hint}
          onClick={() => onChange(id)}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
            view === id ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
          )}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="@max-4xl/chathead:hidden">{label}</span>
        </button>
      ))}
    </div>
  );
}
