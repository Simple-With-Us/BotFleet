import { useStore } from "@/state/store";
import { useMemo } from "react";
import { AlertTriangle, Clock, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

interface NeedsYouItem {
  type: "blocking" | "error";
  botId: string;
  botName: string;
  avatarUrl?: string | null;
  threadId: string;
  title: string;
  timestamp: number;
}

export function NeedsYouList() {
  const { state } = useStore();

  const items = useMemo(() => {
    const list: NeedsYouItem[] = [];

    const findTitle = (threadId: string) => {
      for (const b of state.bots) {
        if (b.threadId === threadId) return `Chat with ${b.name}`;
        const task = b.tasks?.find((t) => t.threadId === threadId);
        if (task) return task.title;
      }
      for (const g of state.groups) {
        if (g.threadId === threadId) return g.name;
        const task = g.tasks?.find((t) => t.threadId === threadId);
        if (task) return task.title;
      }
      return "Unknown Thread";
    };

    for (const bot of state.bots) {
      if (bot.activity === "waiting-on-you" || bot.activity === "dead") {
        const threadId = bot.inflightThreadId || bot.threadId;
        list.push({
          type: bot.activity === "waiting-on-you" ? "blocking" : "error",
          botId: bot.id,
          botName: bot.name,
          avatarUrl: bot.avatarUrl,
          threadId,
          title: findTitle(threadId),
          timestamp: bot.activityStartedAt ?? bot.tasks?.[0]?.lastActivity ?? bot.createdAt ?? 0,
        });
      }
    }

    // Sort: blocking decisions first, then errors, then by oldest timestamp
    return list.sort((a, b) => {
      if (a.type !== b.type) return a.type === "blocking" ? -1 : 1;
      return a.timestamp - b.timestamp;
    });
  }, [state.bots, state.groups]);

  if (items.length === 0) return null;

  return (
    <div className="mb-6 rounded-xl border border-hairline/50 bg-panel shadow-xs overflow-hidden">
      <div className="border-b border-hairline/50 bg-raised/60 px-4 py-2.5">
        <h3 className="text-[13px] font-semibold text-ink">Needs You</h3>
      </div>
      <div className="divide-y divide-hairline/30">
        {items.map((item) => (
          <a
            key={item.botId + item.threadId}
            href={`/?thread=${item.threadId}`}
            className="flex items-center justify-between px-4 py-3 hover:bg-surface transition-colors focus:bg-surface focus:outline-hidden"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative shrink-0 flex items-center justify-center h-8 w-8 rounded-full bg-raised overflow-hidden">
                {item.avatarUrl ? (
                  <img src={item.avatarUrl} alt={item.botName} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-[14px] font-medium text-ink-secondary">{item.botName[0]}</span>
                )}
                <div className={cn(
                  "absolute -bottom-0.5 -right-0.5 rounded-full p-0.5 border-2 border-panel",
                  item.type === "blocking" ? "bg-warning text-white" : "bg-error text-white"
                )}>
                  {item.type === "blocking" ? <Clock size={10} strokeWidth={3} /> : <AlertTriangle size={10} strokeWidth={3} />}
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink truncate">{item.botName}</span>
                  <span className="text-[12px] text-ink-secondary truncate">&mdash; {item.title}</span>
                </div>
                <div className="text-[11px] text-ink-secondary mt-0.5">
                  {item.type === "blocking" ? "Waiting for permission or response" : "Execution failed or wedged"}
                </div>
              </div>
            </div>
            <ChevronRight size={16} className="text-ink-secondary/50 shrink-0" />
          </a>
        ))}
      </div>
    </div>
  );
}
