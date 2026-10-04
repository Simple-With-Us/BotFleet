import { useMemo } from "react";
import {
  AlertCircle,
  Clock,
  FolderGit2,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Bot as BotIcon,
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
import { explicitMemberIdSet } from "@/lib/room-members";

interface FleetMatrixViewProps {
  onSelectApp: (appId: string) => void;
  onSelectBot: (botId: string) => void;
  onOpenAppRoom: (appId: string) => void;
}

export function FleetMatrixView({
  onSelectApp,
  onSelectBot,
  onOpenAppRoom,
}: FleetMatrixViewProps) {
  const { state } = useStore();
  const terminology = getRoomTerminology(state.config);

  const nonDmGroups = useMemo(
    () => state.groups.filter((g) => !g.dm),
    [state.groups],
  );

  const activeBots = useMemo(
    () => state.bots.filter((b) => !b.hidden),
    [state.bots],
  );

  const attentionList = useMemo(
    () => computeRoomAttentionIndex(nonDmGroups, activeBots),
    [nonDmGroups, activeBots],
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

  const cwdBasename = (cwd?: string | null) => {
    if (!cwd) return null;
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || cwd;
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-app p-6">
      {/* Header Banner */}
      <div className="mb-6 flex flex-col gap-3 rounded-xl border border-hairline/50 bg-panel p-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <LayoutGrid size={22} />
            </div>
            <div>
              <h2 className="text-[16px] font-semibold text-ink">
                Fleet Matrix ({terminology.plural} × Bots)
              </h2>
              <p className="text-[12px] text-ink-secondary">
                Mission control view across all software development workspaces and assigned bots.
              </p>
            </div>
          </div>

          {/* Aggregate Telemetry Strip */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-raised/50 px-2.5 py-1 text-[12px]">
              <span className="text-ink-secondary">{terminology.plural}:</span>
              <span className="font-semibold text-ink">{nonDmGroups.length}</span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border border-hairline/40 bg-raised/50 px-2.5 py-1 text-[12px]">
              <span className="text-ink-secondary">Active Bots:</span>
              <span className="font-semibold text-ink">{activeBots.length}</span>
            </div>
            {fleetSummary.totalErrors > 0 && (
              <div className="flex items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1 text-[12px] text-danger font-semibold">
                <AlertCircle size={14} />
                <span>{fleetSummary.totalErrors} Errors</span>
              </div>
            )}
            {fleetSummary.totalNeedsAction > 0 && (
              <div className="flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1 text-[12px] text-warning font-semibold">
                <Clock size={14} />
                <span>{fleetSummary.totalNeedsAction} Needs Action</span>
              </div>
            )}
            {fleetSummary.totalWorking > 0 && (
              <div className="flex items-center gap-1.5 rounded-lg border border-info/30 bg-info/10 px-2.5 py-1 text-[12px] text-info font-semibold">
                <Loader2 size={14} className="animate-spin" />
                <span>{fleetSummary.totalWorking} Working</span>
              </div>
            )}
            {fleetSummary.totalUnread > 0 && (
              <div className="flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1 text-[12px] text-accent font-semibold">
                <MessageSquare size={14} />
                <span>{fleetSummary.totalUnread} Unread</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 2D Matrix Grid */}
      <div className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-hairline/50 bg-panel shadow-xs">
        <table className="w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-hairline/50 bg-raised/60">
              <th className="sticky left-0 z-10 bg-raised/95 px-4 py-3 font-semibold text-ink backdrop-blur-xs min-w-[200px]">
                {terminology.singular} / Repository
              </th>
              <th className="px-3 py-3 font-semibold text-ink-secondary w-[100px] text-center">
                Room Chat
              </th>
              {activeBots.map((bot) => (
                <th
                  key={bot.id}
                  className="px-3 py-3 font-medium text-ink min-w-[140px] text-center"
                >
                  <button
                    type="button"
                    onClick={() => onSelectBot(bot.id)}
                    className="group inline-flex flex-col items-center gap-1 hover:text-primary transition-colors"
                  >
                    <div className="flex h-7 w-7 items-center justify-center rounded-md bg-panel border border-hairline/40 group-hover:border-primary/40">
                      {bot.avatarUrl ? (
                        <img
                          src={bot.avatarUrl}
                          alt=""
                          className="h-6 w-6 rounded-xs object-cover"
                        />
                      ) : (
                        <BotIcon size={14} className="text-ink-secondary" />
                      )}
                    </div>
                    <span className="font-semibold truncate max-w-[120px]">
                      {bot.name}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline/30">
            {nonDmGroups.map((group) => {
              const attention = attentionMap.get(group.id);
              const folderName = cwdBasename(group.cwd);

              const memberSet = explicitMemberIdSet(group.memberIds);

              return (
                <tr key={group.id} className="hover:bg-raised/20 transition-colors">
                  {/* Row Header: App info */}
                  <td className="sticky left-0 z-10 bg-panel/95 px-4 py-3 font-medium text-ink backdrop-blur-xs border-r border-hairline/25">
                    <button
                      type="button"
                      onClick={() => onSelectApp(group.id)}
                      className="group flex flex-col text-left hover:text-primary transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        {group.avatarUrl ? (
                          <img
                            src={group.avatarUrl}
                            alt=""
                            className="h-4 w-4 rounded-xs object-cover"
                          />
                        ) : (
                          <FolderGit2 size={15} className="text-ink-tertiary" />
                        )}
                        <span className="font-semibold text-ink group-hover:text-primary">
                          {group.name}
                        </span>
                      </div>
                      {folderName && (
                        <span className="mt-0.5 text-[10px] text-ink-tertiary truncate max-w-[180px]">
                          📁 {folderName}
                        </span>
                      )}
                      {attention && (attention.errors.count > 0 || attention.needsAction.count > 0 || attention.working.count > 0 || attention.unread.count > 0) && (
                        <div className="mt-1 flex items-center gap-1">
                          {attention.errors.count > 0 && (
                            <span className="flex items-center gap-0.5 rounded-full bg-danger/15 px-1 py-0.2 text-[9px] font-semibold text-danger">
                              <AlertCircle size={9} />
                              {attention.errors.count}
                            </span>
                          )}
                          {attention.needsAction.count > 0 && (
                            <span className="flex items-center gap-0.5 rounded-full bg-warning/20 px-1 py-0.2 text-[9px] font-semibold text-warning">
                              <Clock size={9} />
                              {attention.needsAction.count}
                            </span>
                          )}
                          {attention.working.count > 0 && (
                            <span className="flex items-center gap-0.5 rounded-full bg-info/15 px-1 py-0.2 text-[9px] font-semibold text-info">
                              <Loader2 size={9} className="animate-spin" />
                              {attention.working.count}
                            </span>
                          )}
                          {attention.unread.count > 0 && (
                            <span className="flex items-center gap-0.5 rounded-full bg-accent/20 px-1 py-0.2 text-[9px] font-semibold text-accent">
                              <MessageSquare size={9} />
                              {attention.unread.count}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  </td>

                  {/* Room Chat Cell */}
                  <td className="px-3 py-3 text-center border-r border-hairline/25">
                    <button
                      type="button"
                      onClick={() => onOpenAppRoom(group.id)}
                      title={`Open ${group.name} team room`}
                      className="inline-flex items-center gap-1 rounded-md border border-hairline/40 bg-raised/30 px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
                    >
                      <MessageSquare size={12} />
                      <span>Chat</span>
                      {group.unread && (
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      )}
                    </button>
                  </td>

                  {/* Bot Cells in this App */}
                  {activeBots.map((bot) => {
                    const isAssigned = memberSet.has(bot.id);
                    if (!isAssigned) {
                      return (
                        <td
                          key={bot.id}
                          className="px-3 py-3 text-center text-ink-tertiary/30 border-r border-hairline/15"
                        >
                          —
                        </td>
                      );
                    }

                    const isDead = bot.activity === "dead";
                    const isWaiting = bot.activity === "waiting-on-you";
                    const isWorking = bot.activity === "working" || group.busyBotId === bot.id;
                    const hasUnread = bot.unread;

                    return (
                      <td
                        key={bot.id}
                        className="px-2 py-2 text-center border-r border-hairline/15"
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onSelectApp(group.id);
                            onSelectBot(bot.id);
                          }}
                          className={cn(
                            "inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                            isDead
                              ? "border-danger/40 bg-danger/10 text-danger"
                              : isWaiting
                                ? "border-warning/40 bg-warning/10 text-warning animate-pulse"
                                : isWorking
                                  ? "border-info/40 bg-info/10 text-info"
                                  : hasUnread
                                    ? "border-accent/40 bg-accent/10 text-accent font-semibold"
                                    : "border-hairline/30 bg-raised/20 text-ink-secondary hover:bg-raised/60 hover:text-ink",
                          )}
                        >
                          <span
                            className={cn(
                              "h-1.5 w-1.5 rounded-full shrink-0",
                              isDead
                                ? "bg-danger"
                                : isWaiting
                                  ? "bg-warning"
                                  : isWorking
                                    ? "bg-info animate-spin"
                                    : hasUnread
                                      ? "bg-accent"
                                      : "bg-ink-tertiary/40",
                            )}
                          />
                          <span className="truncate">
                            {isDead
                              ? "Dead"
                              : isWaiting
                                ? "Needs Action"
                                : isWorking
                                  ? "Working"
                                  : hasUnread
                                    ? "Unread"
                                    : "Assigned"}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
