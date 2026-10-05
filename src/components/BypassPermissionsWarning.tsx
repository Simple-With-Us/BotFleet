import { useEffect, useRef } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { evaluateModelRiskForBypass } from "../../shared/model-safety.ts";

export function BypassPermissionsWarning({
  open,
  onCancel,
  onConfirm,
  botName,
  model,
  engineId,
  busy = false,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  botName: string;
  model: string;
  engineId?: string;
  busy?: boolean;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const evaluation = evaluateModelRiskForBypass(model, engineId);

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
        aria-labelledby="bypass-warning-title"
        aria-describedby="bypass-warning-body"
        className="w-full max-w-[460px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          {evaluation.isDangerous ? (
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-danger" />
          ) : (
            <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warning" />
          )}
          <div>
            <h2 id="bypass-warning-title" className="text-[15px] font-semibold text-ink">
              {evaluation.isDangerous
                ? "High-Risk Model: Permission Bypass Warning"
                : `Enable Permission Bypass for ${botName}?`}
            </h2>
            <div id="bypass-warning-body" className="mt-2 space-y-2 text-[13px] leading-relaxed text-ink-secondary">
              <p>
                Bypassing permissions allows <strong className="text-ink">{botName}</strong> to execute commands, file edits, and routine proposals automatically without waiting for manual confirmation cards.
              </p>
              {evaluation.isDangerous ? (
                <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-[12.5px] leading-relaxed text-danger">
                  <div className="font-semibold text-danger">
                    {evaluation.warningTitle} ({evaluation.model})
                  </div>
                  <div className="mt-1 text-danger/90">
                    {evaluation.warningBody}
                  </div>
                  {evaluation.recommendation && (
                    <div className="mt-2 font-medium text-danger/95">
                      {evaluation.recommendation}
                    </div>
                  )}
                </div>
              ) : (
                <p>
                  Tools and shell commands will execute autonomously without interruption.  Destructive system actions will run without stopping.  Ensure this bot's assigned workspace and tools are properly bounded.
                </p>
              )}
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
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
            className={`rounded-xl px-4 py-2 text-[13px] font-medium text-white transition-colors hover:brightness-110 ${
              evaluation.isDangerous ? "bg-danger" : "bg-accent"
            }`}
          >
            {busy
              ? "Applying…"
              : evaluation.isDangerous
              ? "I Understand the Risks, Enable Bypass"
              : "Enable Permission Bypass"}
          </button>
        </div>
      </div>
    </div>
  );
}
