// Gather one bot's separate conversations into a single thread.
//
// The workspace has a merge of its own, but that one moves every bot and
// room at once and only as a side effect of switching the arrangement, so
// a person who wants one bot's threads gathered cannot get it there.  This
// is that action, scoped to one bot, on demand.
//
// The destination is the person's choice, and the default is the OLDEST
// thread: a merge appends the other transcripts to the destination, so
// folding a long history into a newer thread would put the history after
// the recent messages.  Merging into the oldest one leaves the transcript
// reading in chronological order.
//
// Nothing here fails quietly.  A conversation bound to a different App
// cannot merge, so it is left alone and named in the result.
import { useEffect, useMemo, useState } from "react";
import { GitMerge } from "lucide-react";

import { useStore, formatTime, type Bot, type Task } from "@/state/store";
import { cn } from "@/lib/cn";

const messageCount = (task: Task): string | null =>
  typeof task.messageCount === "number" ? task.messageCount.toLocaleString() : null;

/** Oldest first, so the default destination is the one that keeps the
 * transcript in order. */
const chronological = (tasks: Task[]): Task[] => [...tasks].sort((a, b) => a.createdAt - b.createdAt);

export function MergeAllThreadsDialog({
  bot,
  onClose,
}: {
  bot: Bot;
  onClose: () => void;
}) {
  const { dispatch } = useStore();
  const tasks = useMemo(() => chronological(bot.tasks ?? []), [bot.tasks]);
  const [intoThreadId, setIntoThreadId] = useState(() => tasks[0]?.threadId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ merged: number; skipped: Array<{ title: string; reason: string }> } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const destination = tasks.find((task) => task.threadId === intoThreadId);
  const folding = tasks.filter((task) => task.threadId !== intoThreadId);

  const merge = () => {
    if (busy || !intoThreadId) return;
    setBusy(true);
    setError(null);
    dispatch({
      type: "mergeAllBotTasks",
      botId: bot.id,
      intoThreadId,
      onSettled: (outcome, failure) => {
        setBusy(false);
        if (failure || !outcome) {
          setError(failure ?? "that merge did not work");
          return;
        }
        setResult({ merged: outcome.merged.length, skipped: outcome.skipped });
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-labelledby="merge-all-threads-title" data-testid="merge-all-threads-dialog">
      <div className="w-full max-w-md rounded-2xl bg-card p-4 shadow-2xl">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <GitMerge size={16} className="text-ink-secondary" />
          <span id="merge-all-threads-title">Merge All Threads</span>
        </div>

        {result ? (
          <>
            <p className="mt-2 text-[13px] text-ink-secondary">
              {result.merged === 0
                ? "Nothing was merged."
                : `Folded ${result.merged} ${result.merged === 1 ? "conversation" : "conversations"} into ${destination?.title || "the chosen thread"}.`}
            </p>
            {result.skipped.length > 0 && (
              <div className="mt-3 rounded-lg border border-hairline/40 bg-raised/40 px-3 py-2.5">
                <div className="text-[13px] font-medium text-ink">Left on their own</div>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {result.skipped.map((entry) => (
                    <li key={entry.title} className="text-[12.5px] text-ink-secondary">
                      <span className="text-ink">{entry.title}</span>{"\u00A0 "}— {entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white"
                onClick={onClose}
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
              Fold this bot&apos;s other conversations into the one you pick.{"\u00A0 "}Their messages are appended to it, oldest first, so the conversation still reads in order.
            </p>

            <div className="mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto">
              {tasks.map((task) => {
                const selected = task.threadId === intoThreadId;
                const count = messageCount(task);
                return (
                  <label
                    key={task.threadId}
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2",
                      selected ? "border-accent bg-accent/10" : "border-hairline/40 hover:bg-raised/60",
                    )}
                  >
                    <input
                      type="radio"
                      name="merge-all-threads-destination"
                      value={task.threadId}
                      checked={selected}
                      disabled={busy}
                      onChange={() => setIntoThreadId(task.threadId)}
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink">{task.title || "Untitled"}</span>
                      <span className="mt-0.5 block truncate text-[12px] text-ink-secondary">
                        {count !== null ? `${count} ${count === "1" ? "message" : "messages"}` : "no message count"}
                        {"\u00A0 "}· {formatTime(task.lastActivity ?? task.createdAt)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>

            <p className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary" data-testid="merge-all-threads-summary">
              {folding.length} {folding.length === 1 ? "conversation" : "conversations"} will be folded into{" "}
              <span className="text-ink" data-testid="merge-all-threads-destination">{destination?.title || "the chosen thread"}</span>.{"\u00A0 "}This cannot be undone from here.
            </p>

            {error && <p className="mt-2 text-[12.5px] text-danger">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised disabled:opacity-40"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !intoThreadId}
                className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
                onClick={merge}
              >
                {busy ? "Merging…" : "Merge Threads"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
