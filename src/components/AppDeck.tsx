import { useMemo } from "react";
import {
  AlertCircle,
  Clock,
  FolderGit2,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  getRoomTerminology,
  useStore,
} from "@/state/store";
import {
  computeRoomAttentionIndex,
  summarizeFleetAttention,
  type RoomAttention,
} from "@/lib/attention-index";

interface AppDeckProps {
  activeAppId: string | null;
  onSelectApp: (appId: string | null) => void;
  isMatrixOverviewActive?: boolean;
  activeBotId?: string | null;
  onSelectBot?: (botId: string) => void;
  onSelectGroupChat?: (groupId: string) => void;
  isGroupChatActive?: boolean;
}

export function AppDeck({
  activeAppId,
  onSelectApp,
  isMatrixOverviewActive,
  activeBotId,
  onSelectBot,
  onSelectGroupChat,
  isGroupChatActive,
}: AppDeckProps) {
  const { state } = useStore();
  const terminology = getRoomTerminology(state.config);

  const nonDmGroups = useMemo(
    () => state.groups.filter((g) => !g.dm),
    [state.groups],
  );

  const attentionList = useMemo(
    () => computeRoomAttentionIndex(nonDmGroups, state.bots),
    [nonDmGroups, state.bots],
  );

  const attentionMap = useMemo(() => {
    const map = new Map<string, RoomAttention>();
    for (const item of attentionList) {
      map.set(item.roomId, item);
    }
    return map;
  }, [attentionList]);

  const fleetSummary = useMemo(
    () => summarizeFleetAttention(attentionList),
    [attentionList],
  );

  const activeGroup = useMemo(
    () => (activeAppId ? state.groups.find((g) => g.id === activeAppId) : null),
    [activeAppId, state.groups],
  );

  // Bots assigned to the currently selected App
  const assignedBots = useMemo(() => {
    if (!activeGroup) return [];
    const memberSet = new Set(activeGroup.memberIds || []);
    for (const b of state.bots) {
      if (
        !b.hidden &&
        b.section &&
        (b.section === activeGroup.name || b.section === activeGroup.section)
      ) {
        memberSet.add(b.id);
      }
    }
    return state.bots.filter((b) => !b.hidden && memberSet.has(b.id));
  }, [activeGroup, state.bots]);

  const cwdBasename = (cwd?: string | null) => {
    if (!cwd) return null;
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || cwd;
  };

  return (
    <header
      aria-label="App Deck Navigation"
      className="flex flex-col border-b border-hairline/40 bg-panel/85 backdrop-blur-md"
    >
      {/* Primary horizontal deck */}
      <div className="flex h-12 items-center gap-1.5 overflow-x-auto px-3 py-1.5 scrollbar-none">
        {/* All Apps / Overview Tab */}
        <button
          type="button"
          onClick={() => onSelectApp(null)}
          aria-label={`All ${terminology.plural} Matrix Overview`}
          className={cn(
            "group flex shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
            activeAppId === null && isMatrixOverviewActive
              ? "border-primary/40 bg-raised text-ink shadow-xs"
              : "border-transparent text-ink-secondary hover:bg-raised/50 hover:text-ink",
          )}
        >
          <LayoutGrid size={15} className="shrink-0 text-primary" />
          <span>All {terminology.plural}</span>

          {/* Fleet Rollup Indicators */}
          {(fleetSummary.totalErrors > 0 ||
            fleetSummary.totalNeedsAction > 0 ||
            fleetSummary.totalWorking > 0 ||
            fleetSummary.totalUnread > 0) && (
            <div className="flex items-center gap-1">
              {fleetSummary.totalErrors > 0 && (
                <span
                  title={`${fleetSummary.totalErrors} unresolved errors across ${terminology.plural}`}
                  className="flex items-center gap-0.5 rounded-full bg-danger/15 px-1.5 py-0.2 text-[10px] font-semibold text-danger"
                >
                  <AlertCircle size={10} />
                  {fleetSummary.totalErrors}
                </span>
              )}
              {fleetSummary.totalNeedsAction > 0 && (
                <span
                  title={`${fleetSummary.totalNeedsAction} bots waiting for your action`}
                  className="flex items-center gap-0.5 rounded-full bg-warning/20 px-1.5 py-0.2 text-[10px] font-semibold text-warning"
                >
                  <Clock size={10} />
                  {fleetSummary.totalNeedsAction}
                </span>
              )}
              {fleetSummary.totalWorking > 0 && (
                <span
                  title={`${fleetSummary.totalWorking} bots working`}
                  className="flex items-center gap-0.5 rounded-full bg-info/15 px-1.5 py-0.2 text-[10px] font-semibold text-info"
                >
                  <Loader2 size={10} className="animate-spin" />
                  {fleetSummary.totalWorking}
                </span>
              )}
              {fleetSummary.totalUnread > 0 && (
                <span
                  title={`${fleetSummary.totalUnread} unread updates`}
                  className="flex items-center gap-0.5 rounded-full bg-accent/20 px-1.5 py-0.2 text-[10px] font-semibold text-accent"
                >
                  <MessageSquare size={10} />
                  {fleetSummary.totalUnread}
                </span>
              )}
            </div>
          )}
        </button>

        {/* Individual App Chips */}
        {nonDmGroups.map((group) => {
          const attention = attentionMap.get(group.id);
          const isSelected = activeAppId === group.id;
          const folderName = cwdBasename(group.cwd);

          const errorTooltip = attention?.errors.bots.length
            ? `Errors: ${attention.errors.bots.map((b) => b.botName).join(", ")}`
            : undefined;

          const actionTooltip = attention?.needsAction.bots.length
            ? `Waiting for input: ${attention.needsAction.bots.map((b) => b.botName).join(", ")}`
            : undefined;

          const workingTooltip = attention?.working.bots.length
            ? `Working: ${attention.working.bots.map((b) => b.botName).join(", ")}`
            : undefined;

          return (
            <button
              key={group.id}
              type="button"
              onClick={() => onSelectApp(group.id)}
              aria-label={`${group.name} ${terminology.singular}`}
              className={cn(
                "group relative flex shrink-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                isSelected
                  ? "border-primary/50 bg-raised text-ink shadow-xs"
                  : "border-hairline/30 text-ink-secondary hover:border-hairline/80 hover:bg-raised/40 hover:text-ink",
              )}
            >
              {/* App Icon or Avatar */}
              {group.avatarUrl ? (
                <img
                  src={group.avatarUrl}
                  alt=""
                  className="h-4 w-4 shrink-0 rounded-xs object-cover"
                />
              ) : (
                <FolderGit2 size={14} className="shrink-0 text-ink-tertiary" />
              )}

              {/* App Name */}
              <span className="truncate max-w-[140px]">{group.name}</span>

              {/* Repo / Folder Tag */}
              {folderName && (
                <span className="hidden rounded-xs bg-panel px-1 py-0.2 text-[10px] text-ink-tertiary lg:inline">
                  {folderName}
                </span>
              )}

              {/* 4 Typed Badges */}
              {attention && (
                <div className="flex items-center gap-1">
                  {/* 1. Errors */}
                  {attention.errors.count > 0 && (
                    <span
                      title={errorTooltip}
                      className="flex items-center gap-0.5 rounded-full bg-danger/15 px-1.5 py-0.2 text-[10px] font-semibold text-danger"
                    >
                      <AlertCircle size={10} />
                      {attention.errors.count}
                    </span>
                  )}

                  {/* 2. Needs Action */}
                  {attention.needsAction.count > 0 && (
                    <span
                      title={actionTooltip}
                      className="flex items-center gap-0.5 rounded-full bg-warning/20 px-1.5 py-0.2 text-[10px] font-semibold text-warning"
                    >
                      <Clock size={10} />
                      {attention.needsAction.count}
                    </span>
                  )}

                  {/* 3. Working */}
                  {attention.working.count > 0 && (
                    <span
                      title={workingTooltip}
                      className="flex items-center gap-0.5 rounded-full bg-info/15 px-1.5 py-0.2 text-[10px] font-semibold text-info"
                    >
                      <Loader2 size={10} className="animate-spin" />
                      {attention.working.count}
                    </span>
                  )}

                  {/* 4. Unread */}
                  {attention.unread.count > 0 && (
                    <span
                      title={`${attention.unread.count} unread`}
                      className="flex items-center gap-0.5 rounded-full bg-accent/20 px-1.5 py-0.2 text-[10px] font-semibold text-accent"
                    >
                      <MessageSquare size={10} />
                      {attention.unread.count}
                    </span>
                  )}
                </div>
              )}
            </button>
          );
        })}

        {/* Add App Button */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("open-new-channel"))}
          title={`New ${terminology.singular}`}
          aria-label={`New ${terminology.singular}`}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-dashed border-hairline/60 text-ink-tertiary hover:border-hairline hover:bg-raised/40 hover:text-ink transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Sub-bar for selected App: Room chat + Bot Threads */}
      {activeGroup && (
        <div className="flex h-9 items-center gap-1.5 overflow-x-auto border-t border-hairline/25 bg-app/40 px-3 text-[11px] scrollbar-none">
          <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-ink-tertiary">
            {activeGroup.name}:
          </span>

          {/* Group Room Chat Button */}
          <button
            type="button"
            onClick={() => onSelectGroupChat?.(activeGroup.id)}
            aria-label={`${activeGroup.name} Team Chat`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors",
              isGroupChatActive
                ? "bg-primary/15 text-primary"
                : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
            )}
          >
            <MessageSquare size={12} />
            <span>Room Chat</span>
            {activeGroup.unread && (
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            )}
          </button>

          <div className="h-3 w-px bg-hairline/40 shrink-0" />

          {/* Individual Assigned Bots */}
          {assignedBots.length === 0 ? (
            <span className="text-ink-tertiary text-[11px]">
              No bots assigned yet
            </span>
          ) : (
            assignedBots.map((b) => {
              const isBotActive = !isGroupChatActive && activeBotId === b.id;
              const isDead = b.activity === "dead";
              const isWaiting = b.activity === "waiting-on-you";
              const isWorking = b.activity === "working" || activeGroup.busyBotId === b.id;

              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelectBot?.(b.id)}
                  aria-label={`${b.name} thread in ${activeGroup.name}`}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors",
                    isBotActive
                      ? "bg-raised text-ink shadow-xs"
                      : "text-ink-secondary hover:bg-raised/40 hover:text-ink",
                  )}
                >
                  {/* Status dot */}
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full shrink-0",
                      isDead
                        ? "bg-danger"
                        : isWaiting
                          ? "bg-warning animate-pulse"
                          : isWorking
                            ? "bg-info animate-pulse"
                            : b.unread
                              ? "bg-accent"
                              : "bg-ink-tertiary/40",
                    )}
                  />
                  <span>{b.name}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </header>
  );
}
