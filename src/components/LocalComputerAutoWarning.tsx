import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

export const LOCAL_COMPUTER_AUTO_WARNING =
  "Auto mode will let this bot click, type, and run tools on this computer without asking first.\u00a0 Destructive and sensitive actions still stop.\u00a0 Continue only if you are watching.";

export function shouldWarnBeforeAddingLocalAuto(
  computers: readonly string[] | undefined,
  autoApprove: boolean | undefined,
): boolean {
  return autoApprove === true && !computers?.includes("local");
}

export function LocalComputerAutoWarning({
  open,
  onCancel,
  onConfirm,
  bots,
  busy = false,
  title = "Allow Auto Mode on This Computer?",
  body = LOCAL_COMPUTER_AUTO_WARNING,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  bots?: { id: string; name: string }[];
  busy?: boolean;
  /** The second switch stands behind the same warning, but saying "Auto Mode"
   *  there would name the wrong thing, so the caller supplies its wording.
   *  Defaults keep every existing caller's copy exactly as it was. */
  title?: string;
  body?: string;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || busy) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel, busy]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-auto-warning-title"
        aria-describedby="local-auto-warning-body"
        className="w-full max-w-[420px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warning" />
          <div>
            <h2 id="local-auto-warning-title" className="text-[15px] font-semibold text-ink">
              {title}
            </h2>
            <p id="local-auto-warning-body" className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {bots
                ? `Auto mode will let ${bots.length === 1 ? "this bot" : `these ${bots.length} bots`} click, type, and run tools on this computer without asking first.\u00a0 Destructive and sensitive actions still stop.\u00a0 Continue only if you are watching.`
                : body}
            </p>
            {bots && (
              <ul aria-label="Bots Gaining Auto Access" className="mt-3 max-h-48 overflow-y-auto space-y-1 text-[13px] text-ink">
                {bots.map((bot) => (
                  <li key={bot.id} className="break-words">
                    {bot.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110"
          >
            {busy ? "Applying…" : bots ? "Allow Auto Mode" : "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
