import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/** In-app stand-in for `window.confirm` on destructive Settings paths. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
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
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
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
