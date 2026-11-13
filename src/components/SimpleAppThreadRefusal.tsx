import { X } from "lucide-react";

/** The note Simple shows when a matrix cell, an App Deck chip, or a number
 * shortcut would have opened a saved App conversation. */
export function SimpleAppThreadRefusal({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="simple-app-thread-refusal"
      className="flex items-start justify-between gap-3 border-b border-hairline/40 bg-raised/60 px-4 py-2.5"
    >
      <div className="min-w-0">
        <div className="text-[14px] font-medium text-ink">This Stays Separate</div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{message}</p>
      </div>
      <button
        type="button"
        aria-label="Dismiss Notice"
        onClick={onDismiss}
        className="shrink-0 rounded-md p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  );
}
