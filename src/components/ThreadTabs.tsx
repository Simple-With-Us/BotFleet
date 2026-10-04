// Safari-style thread tabs for a bot or channel.
//
// The old TaskPicker was a single bubble that hid every other conversation
// behind a menu. Active threads now sit in a top tab bar: click to switch,
// double-click or right-click to rename, plus to start a fresh one.
import { useEffect, useRef, useState } from "react";
import { GitMerge, Plus, X } from "lucide-react";
import { useStore, formatTime, getRoomTerminology, type Bot, type Group, type Task } from "@/state/store";
import { TaskWorkspaceLabel } from "./TaskWorkspaceLabel";
import { cn } from "@/lib/cn";
import { nextRename } from "@/lib/rename";
import { TASK_RENAME_HINT, taskPickerPointerIntent } from "./TaskPicker";
import { formatTokens } from "@/lib/format-tokens";

type TabTask = Pick<Task, "threadId" | "title" | "createdAt"> & {
  lastActivity?: number;
  usage?: Task["usage"];
};

function ConversationThreadTabs({
  threadId,
  tasks,
  busy,
  onNew,
  onSwitch,
  onRename,
  onDelete,
  onMerge,
}: {
  threadId: string;
  tasks: TabTask[];
  busy: boolean;
  onNew: () => void;
  onSwitch: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
  onMerge?: (threadId: string, intoThreadId: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const finishingRename = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [pendingMerge, setPendingMerge] = useState<{ from: string; into: string } | null>(null);

  const current = tasks.find((task) => task.threadId === threadId);

  useEffect(() => {
    const el = scroller.current?.querySelector("[data-active-thread='true']");
    if (el instanceof HTMLElement) el.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [threadId]);

  const startRename = (task: TabTask) => {
    finishingRename.current = false;
    setDraft(task.title);
    setRenaming(task.threadId);
  };

  const commitRename = (id: string, save: boolean) => {
    if (finishingRename.current) return;
    finishingRename.current = true;
    const currentTitle = tasks.find((task) => task.threadId === id)?.title ?? "";
    const title = save ? nextRename(currentTitle, draft) : null;
    setRenaming(null);
    if (title) onRename(id, title);
  };

  return (
    <div
      className="flex min-w-0 items-stretch gap-0 border-b border-hairline/40 bg-app"
      role="tablist"
      aria-label="Threads"
    >
      <div
        ref={scroller}
        className="flex min-w-0 flex-1 items-stretch gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tasks.map((task) => {
          const active = task.threadId === threadId;
          const usage = task.usage;
          const usageLabel = usage ? formatTokens(usage.input + usage.output) : null;
          return (
            <div
              key={task.threadId}
              data-active-thread={active ? "true" : undefined}
              className={cn(
                "group relative flex min-w-[7.5rem] max-w-[16rem] shrink-0 items-center border-b-2 px-1",
                active ? "border-accent bg-raised/40" : "border-transparent hover:bg-raised/30",
                picked.includes(task.threadId) && "bg-accent/15",
              )}
            >
              {renaming === task.threadId ? (
                <input
                  autoFocus
                  value={draft}
                  maxLength={80}
                  aria-label="Rename Thread"
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(task.threadId, true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      commitRename(task.threadId, true);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      commitRename(task.threadId, false);
                    }
                  }}
                  className="m-1 min-w-0 flex-1 rounded bg-inset px-1.5 py-1 text-[13px] text-ink focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={busy && !active}
                  title={`${task.title || "Untitled"} · ${TASK_RENAME_HINT}${usageLabel ? ` · ${usageLabel}` : ""}`}
                  onClick={(e) => {
                    if (taskPickerPointerIntent("click", e.detail) !== "select") return;
                    if (e.metaKey || e.ctrlKey) {
                      e.preventDefault();
                      setPicked((current) =>
                        current.includes(task.threadId)
                          ? current.filter((id) => id !== task.threadId)
                          : [...current, task.threadId],
                      );
                      return;
                    }
                    setPicked([]);
                    if (!active) onSwitch(task.threadId);
                  }}
                  draggable={Boolean(onMerge)}
                  onDragStart={(event) => {
                    if (!onMerge) return;
                    event.dataTransfer.setData("text/plain", task.threadId);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => {
                    if (!onMerge) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    if (!onMerge) return;
                    event.preventDefault();
                    const from = event.dataTransfer.getData("text/plain");
                    if (!from || from === task.threadId) return;
                    setPendingMerge({ from, into: task.threadId });
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startRename(task);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startRename(task);
                  }}
                  className={cn(
                    "min-w-0 flex-1 truncate px-2 py-2 text-left text-[13px]",
                    active ? "font-semibold text-ink" : "text-ink-secondary",
                    busy && !active && "opacity-40",
                  )}
                >
                  <span className="block truncate">{task.title || "Untitled"}</span>
                  <span className="block truncate text-[10.5px] font-normal text-ink-secondary">
                    {formatTime(task.lastActivity ?? task.createdAt)}
                  </span>
                </button>
              )}
              {tasks.length > 1 && renaming !== task.threadId && (
                <button
                  type="button"
                  onClick={() => onDelete(task.threadId)}
                  disabled={busy && active}
                  aria-label={`Close ${task.title || "thread"}`}
                  title="Delete this thread and its conversation"
                  className="mr-1 rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-danger group-hover:opacity-100 disabled:opacity-20"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {onMerge && picked.length >= 2 && (
        <button
          type="button"
          onClick={() => {
            const into = picked.includes(threadId) ? threadId : picked[0];
            const rest = picked.filter((id) => id !== into);
            const first = rest[0];
            if (first) setPendingMerge({ from: first, into });
          }}
          className="flex shrink-0 items-center gap-1 border-l border-hairline/40 px-3 text-[13px] font-medium text-ink hover:bg-raised"
        >
          <GitMerge size={14} />
          <span className="hidden sm:inline">Merge Threads</span>
        </button>
      )}
      <button
        type="button"
        onClick={onNew}
        disabled={busy}
        title={busy ? "Let this turn finish first" : "New thread — a fresh conversation"}
        aria-label="New Thread"
        className="flex shrink-0 items-center gap-1 border-l border-hairline/40 px-3 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
      >
        <Plus size={14} />
        <span className="hidden sm:inline">New</span>
      </button>
      {current ? <span className="sr-only">Current thread: {current.title}</span> : null}
      {pendingMerge && onMerge && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-labelledby="merge-threads-title">
          <div className="w-full max-w-sm rounded-2xl bg-card p-4 shadow-2xl">
            <div id="merge-threads-title" className="text-[15px] font-semibold text-ink">Merge Threads?</div>
            <p className="mt-2 text-[13px] text-ink-secondary">
              This folds the dragged conversation into the other thread.  You cannot undo it from this bar.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised" onClick={() => setPendingMerge(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
                onClick={() => {
                  onMerge(pendingMerge.from, pendingMerge.into);
                  setPicked([]);
                  setPendingMerge(null);
                }}
              >
                Merge Threads
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ThreadTabs({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const tasks = bot.tasks ?? [];
  const context = tasks.find((task) => task.threadId === bot.threadId)?.workspaceContext;
  if (tasks.length === 0) return null;
  return (
    <>
      <ConversationThreadTabs
        threadId={bot.threadId}
        tasks={tasks}
        busy={Boolean(bot.busy)}
        onNew={() => dispatch({ type: "requestNewTask", botId: bot.id })}
        onSwitch={(threadId) => dispatch({ type: "switchTask", botId: bot.id, threadId })}
        onRename={(threadId, title) => dispatch({ type: "renameTask", botId: bot.id, threadId, title })}
        onDelete={(threadId) => dispatch({ type: "deleteTask", botId: bot.id, threadId })}
        onMerge={(threadId, intoThreadId) => dispatch({ type: "mergeTasks", botId: bot.id, threadId, intoThreadId })}
      />
      {context && (
        <TaskWorkspaceLabel
          context={context}
          appName={state.groups.find((group) => group.id === context.appRef.id)?.name}
          groupNoun={getRoomTerminology(state.config).singular}
        />
      )}
    </>
  );
}

export function GroupThreadTabs({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const tasks = group.tasks ?? [];
  const context = tasks.find((task) => task.threadId === group.threadId)?.workspaceContext;
  if (group.dm || tasks.length === 0) return null;
  return (
    <>
      <ConversationThreadTabs
        threadId={group.threadId}
        tasks={tasks}
        busy={Boolean(group.busyBotId)}
        onNew={() => dispatch({ type: "newGroupTask", groupId: group.id })}
        onSwitch={(threadId) => dispatch({ type: "switchGroupTask", groupId: group.id, threadId })}
        onRename={(threadId, title) => dispatch({ type: "renameGroupTask", groupId: group.id, threadId, title })}
        onDelete={(threadId) => dispatch({ type: "deleteGroupTask", groupId: group.id, threadId })}
      />
      {context && (
        <TaskWorkspaceLabel
          context={context}
          appName={state.groups.find((app) => app.id === context.appRef.id)?.name}
          groupNoun={getRoomTerminology(state.config).singular}
        />
      )}
    </>
  );
}
