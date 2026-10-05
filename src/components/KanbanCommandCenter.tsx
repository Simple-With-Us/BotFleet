import { useMemo, useState } from "react";
import {
  AlertCircle,
  Clock,
  CheckCircle2,
  FolderGit2,
  Loader2,
  MessageSquare,
  Search,
  Bot as BotIcon,
  Play,
  Sparkles,
} from "lucide-react";
import { getRoomTerminology, useStore } from "@/state/store";
import type { RoutineRun } from "@/lib/routines";

interface KanbanCommandCenterProps {
  onSelectApp: (appId: string) => void;
  onSelectBot: (botId: string) => void;
  onOpenAppRoom: (appId: string) => void;
  filterAppId?: string | null;
}

export type KanbanColumnId = "attention" | "in_progress" | "ready" | "completed";

export interface KanbanCardItem {
  id: string;
  column: KanbanColumnId;
  title: string;
  subtitle?: string;
  appId?: string;
  appName?: string;
  appAvatar?: string | null;
  botId?: string;
  botName?: string;
  botAvatar?: string | null;
  statusText: string;
  statusKind: "danger" | "warning" | "info" | "success" | "neutral";
  waitingMs?: number;
  timestamp: number;
  unblockValue: number; // Higher number = higher priority to show at top
  rawRun?: RoutineRun;
}

export function safeAvatarUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    if (!URL.canParse(url)) return null;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function KanbanCommandCenter({
  onSelectApp,
  onSelectBot,
  onOpenAppRoom,
  filterAppId,
}: KanbanCommandCenterProps) {
  const { state } = useStore();
  const terminology = getRoomTerminology(state.config);
  const [searchQuery, setSearchQuery] = useState("");

  const appMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string; avatarUrl?: string | null; memberIds: string[] }>();
    for (const g of state.groups) {
      if (!g.dm) {
        map.set(g.id, {
          id: g.id,
          name: g.name,
          avatarUrl: g.avatarUrl,
          memberIds: g.memberIds || [],
        });
      }
    }
    return map;
  }, [state.groups]);

  const botMap = useMemo(() => {
    const map = new Map<string, (typeof state.bots)[0]>();
    for (const b of state.bots) {
      map.set(b.id, b);
    }
    return map;
  }, [state.bots]);

  const cards = useMemo(() => {
    const items: KanbanCardItem[] = [];
    const now = Date.now();

    // 1. Synthesize cards from Bot states
    for (const bot of state.bots) {
      if (bot.hidden) continue;

      // Find apps this bot belongs to
      const assignedApps = Array.from(appMap.values()).filter((a) =>
        a.memberIds.includes(bot.id)
      );

      const primaryApp = assignedApps[0];
      if (filterAppId && !assignedApps.some((a) => a.id === filterAppId)) {
        continue;
      }

      const lastMsg = bot.messages && bot.messages.length > 0 ? bot.messages[bot.messages.length - 1] : undefined;
      const botTimestamp = bot.activityStartedAt || lastMsg?.at || now;

      if (bot.activity === "waiting-on-you") {
        items.push({
          id: `bot-waiting-${bot.id}`,
          column: "attention",
          title: `${bot.name} is waiting for decision`,
          subtitle: bot.description || "Requires user confirmation or prompt input to resume.",
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: bot.id,
          botName: bot.name,
          botAvatar: bot.avatarUrl,
          statusText: "Waiting On You",
          statusKind: "warning",
          waitingMs: now - botTimestamp > 0 ? now - botTimestamp : 60000,
          timestamp: botTimestamp,
          unblockValue: 90,
        });
      } else if (bot.activity === "dead") {
        items.push({
          id: `bot-dead-${bot.id}`,
          column: "attention",
          title: `${bot.name} encountered an unhandled crash`,
          subtitle: "Process died or disconnected without exit receipt.",
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: bot.id,
          botName: bot.name,
          botAvatar: bot.avatarUrl,
          statusText: "Dead / Crash",
          statusKind: "danger",
          waitingMs: now - botTimestamp > 0 ? now - botTimestamp : 120000,
          timestamp: botTimestamp,
          unblockValue: 100,
        });
      } else if (bot.activity === "working") {
        items.push({
          id: `bot-working-${bot.id}`,
          column: "in_progress",
          title: `${bot.name} is executing a turn`,
          subtitle: bot.busy ? "Running tools and formulating response..." : (bot.description || "Executing turn..."),
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: bot.id,
          botName: bot.name,
          botAvatar: bot.avatarUrl,
          statusText: "In Flight",
          statusKind: "info",
          timestamp: botTimestamp,
          unblockValue: 50,
        });
      } else if (bot.activity === "idle") {
        items.push({
          id: `bot-idle-${bot.id}`,
          column: "ready",
          title: `${bot.name}`,
          subtitle: bot.description || "Ready for task assignment.",
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: bot.id,
          botName: bot.name,
          botAvatar: bot.avatarUrl,
          statusText: "Standby",
          statusKind: "neutral",
          timestamp: botTimestamp,
          unblockValue: 10,
        });
      }
    }

    // 2. Synthesize cards from Routine Runs
    for (const run of state.routineRuns || []) {
      const assignedBot = botMap.get(run.botId);
      const assignedApps = assignedBot
        ? Array.from(appMap.values()).filter((a) => a.memberIds.includes(assignedBot.id))
        : [];
      const primaryApp = assignedApps[0];

      if (filterAppId && !assignedApps.some((a) => a.id === filterAppId)) {
        continue;
      }

      if (run.status === "failed") {
        items.push({
          id: `run-${run.id}`,
          column: "attention",
          title: run.routineName || "Automated Routine Run",
          subtitle: run.error || "Run failed with non-zero exit code or timeout.",
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: assignedBot?.id,
          botName: assignedBot?.name || "Routine Bot",
          botAvatar: assignedBot?.avatarUrl,
          statusText: "Run Failed",
          statusKind: "danger",
          waitingMs: now - (run.finishedAt || run.scheduledFor),
          timestamp: run.finishedAt || run.scheduledFor,
          unblockValue: 80,
          rawRun: run,
        });
      } else if (run.status === "waiting") {
        items.push({
          id: `run-${run.id}`,
          column: "attention",
          title: run.routineName || "Routine Approval",
          subtitle: run.prompt || "Routine paused waiting for manual confirmation.",
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: assignedBot?.id,
          botName: assignedBot?.name || "Routine Bot",
          botAvatar: assignedBot?.avatarUrl,
          statusText: "Approval Needed",
          statusKind: "warning",
          waitingMs: now - (run.startedAt || run.scheduledFor),
          timestamp: run.startedAt || run.scheduledFor,
          unblockValue: 85,
          rawRun: run,
        });
      } else if (run.status === "running") {
        items.push({
          id: `run-${run.id}`,
          column: "in_progress",
          title: run.routineName || "Executing Routine",
          subtitle: run.prompt || "Routine turn is running in background.",
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: assignedBot?.id,
          botName: assignedBot?.name || "Routine Bot",
          botAvatar: assignedBot?.avatarUrl,
          statusText: "Running Routine",
          statusKind: "info",
          timestamp: run.startedAt || now,
          unblockValue: 60,
          rawRun: run,
        });
      } else if (run.status === "queued") {
        items.push({
          id: `run-${run.id}`,
          column: "ready",
          title: run.routineName || "Scheduled Task",
          subtitle: run.prompt || "Queued in runner pipeline.",
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: assignedBot?.id,
          botName: assignedBot?.name || "Routine Bot",
          botAvatar: assignedBot?.avatarUrl,
          statusText: "Queued",
          statusKind: "neutral",
          timestamp: run.scheduledFor,
          unblockValue: 20,
          rawRun: run,
        });
      } else if (run.status === "completed") {
        items.push({
          id: `run-${run.id}`,
          column: "completed",
          title: run.routineName || "Completed Routine",
          subtitle: run.output ? run.output.slice(0, 120) : "Finished cleanly with success code.",
          appId: primaryApp?.id,
          appName: primaryApp?.name,
          appAvatar: primaryApp?.avatarUrl,
          botId: assignedBot?.id,
          botName: assignedBot?.name || "Routine Bot",
          botAvatar: assignedBot?.avatarUrl,
          statusText: "Success",
          statusKind: "success",
          timestamp: run.finishedAt || now,
          unblockValue: 5,
          rawRun: run,
        });
      }
    }

    return items;
  }, [state.bots, state.routineRuns, appMap, botMap, filterAppId]);

  const filteredCards = useMemo(() => {
    if (!searchQuery.trim()) return cards;
    const q = searchQuery.toLowerCase();
    return cards.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.subtitle && c.subtitle.toLowerCase().includes(q)) ||
        (c.appName && c.appName.toLowerCase().includes(q)) ||
        (c.botName && c.botName.toLowerCase().includes(q))
    );
  }, [cards, searchQuery]);

  // Group into 4 columns, strictly sorted by unblock priority and wait duration
  const columns = useMemo(() => {
    const attention: KanbanCardItem[] = [];
    const in_progress: KanbanCardItem[] = [];
    const ready: KanbanCardItem[] = [];
    const completed: KanbanCardItem[] = [];
    const colMap = { attention, in_progress, ready, completed };

    for (const card of filteredCards) {
      colMap[card.column].push(card);
    }

    // Sort Attention Queue: highest unblockValue first, then longest waitingMs
    colMap.attention.sort((a, b) => {
      if (b.unblockValue !== a.unblockValue) {
        return b.unblockValue - a.unblockValue;
      }
      return (b.waitingMs || 0) - (a.waitingMs || 0);
    });

    // Sort In Progress: latest active first
    colMap.in_progress.sort((a, b) => b.timestamp - a.timestamp);

    // Sort Ready: title alphabetical
    colMap.ready.sort((a, b) => a.title.localeCompare(b.title));

    // Sort Completed: most recent first
    colMap.completed.sort((a, b) => b.timestamp - a.timestamp);

    return colMap;
  }, [filteredCards]);

  const formatWaitTime = (ms?: number) => {
    if (!ms || ms <= 0) return null;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  };

  const handleCardClick = (card: KanbanCardItem) => {
    if (card.appId) {
      onSelectApp(card.appId);
    }
    if (card.botId) {
      onSelectBot(card.botId);
    }
  };

  return (
    <div className="flex h-full flex-col min-w-0">
      {/* Kanban Sub-Header: Search & Telemetry */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-tertiary"
            />
            <input
              type="text"
              placeholder="Filter tasks, bots, or apps..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-60 rounded-md border border-hairline/60 bg-panel pl-8 pr-3 text-[12px] text-ink placeholder:text-ink-tertiary focus:border-primary focus:outline-none"
            />
          </div>
          {filterAppId && (
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              Filtered to {appMap.get(filterAppId)?.name || terminology.singular}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-[11px] text-ink-secondary">
          <span>{filteredCards.length} Cards</span>
          <span>•</span>
          <span className="text-warning font-medium">
            {columns.attention.length} Needs Action
          </span>
          <span>•</span>
          <span className="text-info font-medium">
            {columns.in_progress.length} In Progress
          </span>
        </div>
      </div>

      {/* 4-Column Board */}
      <div className="grid flex-1 grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 overflow-x-auto pb-4">
        {/* Column 1: Attention Queue */}
        <div className="flex flex-col rounded-xl border border-hairline/60 bg-raised/30 p-3 min-w-[260px]">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-danger/15 text-danger">
                <AlertCircle size={12} />
              </span>
              <h3 className="text-[13px] font-semibold text-ink">Attention Queue</h3>
            </div>
            <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-ink-secondary">
              {columns.attention.length}
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
            {columns.attention.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-hairline/50 p-6 text-center text-ink-tertiary">
                <CheckCircle2 size={24} className="mb-2 text-success/60" />
                <span className="text-[12px]">All clear.  No blocked bots or pending approvals.</span>
              </div>
            ) : (
              columns.attention.map((card) => {
                const waitLabel = formatWaitTime(card.waitingMs);
                return (
                  <div
                    key={card.id}
                    onClick={() => handleCardClick(card)}
                    className="group relative flex flex-col gap-2 rounded-lg border border-warning/30 bg-panel p-3 shadow-xs hover:border-warning hover:shadow-sm cursor-pointer transition-all"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 rounded-sm bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                        {card.statusText}
                      </span>
                      {waitLabel && (
                        <span className="flex items-center gap-1 text-[10px] text-ink-tertiary">
                          <Clock size={10} />
                          {waitLabel}
                        </span>
                      )}
                    </div>

                    <h4 className="text-[12px] font-semibold text-ink group-hover:text-primary transition-colors">
                      {card.title}
                    </h4>

                    {card.subtitle && (
                      <p className="line-clamp-2 text-[11px] text-ink-secondary">
                        {card.subtitle}
                      </p>
                    )}

                    <div className="mt-1 flex items-center justify-between border-t border-hairline/30 pt-2 text-[11px]">
                      <div className="flex items-center gap-1.5 text-ink-secondary">
                        {safeAvatarUrl(card.appAvatar) ? (
                          <img src={safeAvatarUrl(card.appAvatar)!} alt="" className="h-3.5 w-3.5 rounded-xs" />
                        ) : (
                          <FolderGit2 size={12} className="text-ink-tertiary" />
                        )}
                        <span className="truncate max-w-[90px]">{card.appName || "Workspace"}</span>
                        {card.appId && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenAppRoom(card.appId!);
                            }}
                            title={`Open ${card.appName} team room`}
                            className="p-0.5 text-ink-tertiary hover:text-primary transition-colors"
                          >
                            <MessageSquare size={11} />
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-1 font-medium text-primary">
                        <span>Unblock</span>
                        <Play size={10} />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Column 2: In Progress */}
        <div className="flex flex-col rounded-xl border border-hairline/60 bg-raised/30 p-3 min-w-[260px]">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-info/15 text-info">
                <Loader2 size={12} className="animate-spin" />
              </span>
              <h3 className="text-[13px] font-semibold text-ink">In Progress</h3>
            </div>
            <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-ink-secondary">
              {columns.in_progress.length}
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
            {columns.in_progress.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-hairline/50 p-6 text-center text-ink-tertiary">
                <span className="text-[12px]">No bots actively running turns right now.</span>
              </div>
            ) : (
              columns.in_progress.map((card) => (
                <div
                  key={card.id}
                  onClick={() => handleCardClick(card)}
                  className="group relative flex flex-col gap-2 rounded-lg border border-hairline/60 bg-panel p-3 shadow-xs hover:border-info/60 hover:shadow-sm cursor-pointer transition-all"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 rounded-sm bg-info/15 px-1.5 py-0.5 text-[10px] font-semibold text-info">
                      <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse" />
                      {card.statusText}
                    </span>
                  </div>

                  <h4 className="text-[12px] font-semibold text-ink group-hover:text-primary transition-colors">
                    {card.title}
                  </h4>

                  {card.subtitle && (
                    <p className="line-clamp-2 text-[11px] text-ink-secondary">
                      {card.subtitle}
                    </p>
                  )}

                  <div className="mt-1 flex items-center justify-between border-t border-hairline/30 pt-2 text-[11px]">
                    <div className="flex items-center gap-1.5 text-ink-secondary">
                      {safeAvatarUrl(card.botAvatar) ? (
                        <img src={safeAvatarUrl(card.botAvatar)!} alt="" className="h-3.5 w-3.5 rounded-xs" />
                      ) : (
                        <BotIcon size={12} className="text-ink-tertiary" />
                      )}
                      <span className="truncate max-w-[100px]">{card.botName}</span>
                    </div>

                    <span className="text-[10px] text-ink-tertiary">Live Thread →</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Column 3: Ready / Available */}
        <div className="flex flex-col rounded-xl border border-hairline/60 bg-raised/30 p-3 min-w-[260px]">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-raised text-ink-secondary">
                <Sparkles size={12} />
              </span>
              <h3 className="text-[13px] font-semibold text-ink">Ready & Standby</h3>
            </div>
            <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-ink-secondary">
              {columns.ready.length}
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
            {columns.ready.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-hairline/50 p-6 text-center text-ink-tertiary">
                <span className="text-[12px]">All bots busy or assigned to other tasks.</span>
              </div>
            ) : (
              columns.ready.map((card) => (
                <div
                  key={card.id}
                  onClick={() => handleCardClick(card)}
                  className="group relative flex flex-col gap-2 rounded-lg border border-hairline/40 bg-panel/70 p-3 shadow-2xs hover:bg-panel hover:border-hairline hover:shadow-xs cursor-pointer transition-all"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 rounded-sm bg-raised px-1.5 py-0.5 text-[10px] text-ink-secondary">
                      {card.statusText}
                    </span>
                    {card.appName && (
                      <span className="text-[10px] text-ink-tertiary truncate max-w-[90px]">
                        {card.appName}
                      </span>
                    )}
                  </div>

                  <h4 className="text-[12px] font-semibold text-ink group-hover:text-primary transition-colors">
                    {card.title}
                  </h4>

                  {card.subtitle && (
                    <p className="line-clamp-2 text-[11px] text-ink-tertiary">
                      {card.subtitle}
                    </p>
                  )}

                  <div className="mt-1 flex items-center justify-between border-t border-hairline/20 pt-2 text-[11px]">
                    <span className="text-[10px] text-ink-tertiary">Click to prompt</span>
                    <MessageSquare size={11} className="text-ink-tertiary group-hover:text-primary" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Column 4: Completed Output */}
        <div className="flex flex-col rounded-xl border border-hairline/60 bg-raised/30 p-3 min-w-[260px]">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success/15 text-success">
                <CheckCircle2 size={12} />
              </span>
              <h3 className="text-[13px] font-semibold text-ink">Completed</h3>
            </div>
            <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-ink-secondary">
              {columns.completed.length}
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
            {columns.completed.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-hairline/50 p-6 text-center text-ink-tertiary">
                <span className="text-[12px]">Finished routine runs will appear here with output receipts.</span>
              </div>
            ) : (
              columns.completed.slice(0, 15).map((card) => (
                <div
                  key={card.id}
                  onClick={() => handleCardClick(card)}
                  className="group relative flex flex-col gap-1.5 rounded-lg border border-hairline/30 bg-panel/60 p-3 shadow-2xs hover:bg-panel hover:border-hairline/80 cursor-pointer transition-all"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 rounded-sm bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
                      <CheckCircle2 size={10} />
                      {card.statusText}
                    </span>
                    <span className="text-[10px] text-ink-tertiary">
                      {new Date(card.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>
                  </div>

                  <h4 className="text-[12px] font-medium text-ink group-hover:text-primary transition-colors">
                    {card.title}
                  </h4>

                  {card.subtitle && (
                    <p className="line-clamp-2 text-[10px] text-ink-tertiary font-mono bg-raised/40 p-1.5 rounded">
                      {card.subtitle}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
