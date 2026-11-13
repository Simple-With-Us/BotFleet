import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** A third outcome, for a dialog that asks a real question rather than
   *  "are you sure".  Sits between Cancel and Confirm. */
  altLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onAlt?: () => void;
};

/** In-app stand-in for `window.confirm` on destructive Settings paths. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  altLabel,
  destructive = true,
  busy = false,
  onCancel,
  onConfirm,
  onAlt,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const altRef = useRef<HTMLButtonElement>(null);
  // Escape and the Cancel button mean "leave everything as it is", which is
  // exactly right for a question with a third answer — so the third button is
  // never the Cancel slot.  It gets its own action instead.
  const hasAlt = altLabel !== undefined && onAlt !== undefined;
  // Three ways out means Enter should do the reversible one.  Without an alt
  // this is the confirm button, so every two-button caller is unchanged.
  const initialFocus = hasAlt ? altRef : confirmRef;
  // Callers pass an inline `onCancel`, so its identity changes every render.
  // Held in a ref so the key handler always calls the current one while the
  // focus effect below stays keyed to the dialog, not to the callback: this
  // dialog opens over a working bot, so its parent re-renders continuously
  // and a bare `onCancel` dependency would pull focus back mid-keystroke.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!open || busy) return;
    initialFocus.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, initialFocus]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => !busy && event.target === event.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
        className="w-full max-w-[420px] min-w-[320px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl resize overflow-auto"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className={`mt-0.5 shrink-0 ${destructive ? "text-danger" : "text-warning"}`} />
          <div>
            <h2 id="confirm-dialog-title" className="text-[15px] font-semibold text-ink">
              {title}
            </h2>
            <p id="confirm-dialog-body" className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
              {body}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          {hasAlt && (
            <button
              ref={altRef}
              type="button"
              disabled={busy}
              onClick={onAlt}
              className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
            >
              {altLabel}
            </button>
          )}
          <button
            ref={hasAlt ? undefined : confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`rounded-xl px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50 ${
              destructive ? "bg-danger" : "bg-accent"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
