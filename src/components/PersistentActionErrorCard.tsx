import { AlertTriangle, X } from "lucide-react";

/** A settings-card error that stays visible until the person hides it. */
export function PersistentActionErrorCard({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed text-danger">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-danger/10 hover:text-ink"
        aria-label="Hide this message"
      >
        <span className="flex items-center gap-1">
          <X size={12} aria-hidden />
          Hide
        </span>
      </button>
    </div>
  );
}
