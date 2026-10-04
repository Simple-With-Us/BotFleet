import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { TaskAppRef } from "../../shared/task-workspace-context";

export type NewTaskAppDialogProps = {
  botName: string;
  apps: Array<{ id: string; name: string; cwd: string }>;
  groupNoun: string;
  busy: boolean;
  onChoose: (appRef?: TaskAppRef) => void;
  onCancel: () => void;
};

export function NewTaskAppDialog({
  botName,
  apps,
  groupNoun,
  busy,
  onChoose,
  onCancel,
}: NewTaskAppDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const unassignedRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  const onCancelRef = useRef(onCancel);
  const article = /^[aeiou]/i.test(groupNoun) ? "an" : "a";

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (busyRef.current) cancelRef.current?.focus();
    else unassignedRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (document.activeElement === dialog || document.activeElement === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, []);

  const choose = (appRef?: TaskAppRef) => {
    if (busy) return;
    onChoose(appRef);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-app-title"
        aria-describedby="new-task-app-description"
        tabIndex={-1}
        className="flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline/40 px-5 py-4">
          <div className="min-w-0">
            <h2 id="new-task-app-title" className="text-[16px] font-semibold text-ink">
              New Thread
            </h2>
            <p id="new-task-app-description" className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
              Choose {article} {groupNoun} for {botName}, or leave this thread unassigned.
            </p>
          </div>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            aria-label="Close New Thread"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 space-y-2 overflow-y-auto p-4">
          <button
            ref={unassignedRef}
            type="button"
            disabled={busy}
            onClick={() => choose()}
            className="w-full rounded-xl border border-hairline/50 bg-card px-4 py-3 text-left hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="block text-[13px] font-medium text-ink">Unassigned</span>
            <span className="mt-0.5 block text-[12px] text-ink-secondary">
              Create this thread without choosing {article} {groupNoun}.
            </span>
          </button>

          {apps.map((app) => (
            <button
              key={app.id}
              type="button"
              disabled={busy}
              aria-label={`${app.name}.  Folder: ${app.cwd}`}
              title={`${app.name} — ${app.cwd}`}
              onClick={() => choose({ kind: "group", id: app.id })}
              className="w-full min-w-0 rounded-xl border border-hairline/50 bg-card px-4 py-3 text-left hover:bg-raised/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="block text-[13px] font-medium text-ink">{app.name}</span>
              <span className="mt-1 block text-[11px] font-medium text-ink-secondary">Folder</span>
              <code className="mt-0.5 block text-left text-[12px] leading-relaxed text-ink-secondary [overflow-wrap:anywhere]">
                {app.cwd}
              </code>
            </button>
          ))}
        </div>

        {busy && (
          <p role="status" className="border-t border-hairline/40 px-5 py-3 text-[12px] text-ink-secondary">
            {botName} is working.{"\u00A0 "}Wait for the current turn to finish.
          </p>
        )}

        <footer className="flex justify-end border-t border-hairline/40 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
