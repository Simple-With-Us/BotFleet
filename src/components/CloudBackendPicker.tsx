// The Box / Self-hosted VPS segmented control shown under the "Runs on"
// picker whenever a bot can end up on a cloud computer. One component, two
// homes (ComputerPanel and SettingsPanel), so the copy and the disabled
// rules can never drift apart.
import { useId } from "react";
import type { CloudBackend } from "../../server/contracts.ts";
import { cn } from "@/lib/cn";

export function CloudBackendPicker({
  value,
  inherited,
  vpsSupported,
  engineName,
  onChange,
}: {
  /** The backend actually in effect — resolved, so for a bot that never chose
   * one this is the workspace default rather than the bot's empty field.  A
   * lit segment says "this is what happens", and it has to be true. */
  value: CloudBackend;
  /** That value came from the workspace default, not from this bot.  Without
   * the note below, a resolved `value` is indistinguishable from a choice the
   * person made, and picking either segment silently pins it. */
  inherited?: boolean;
  vpsSupported: boolean;
  /** The selected engine's display name, named in the note that explains a
   * disabled Self-hosted VPS segment.  Omitted (still loading, or an engine
   * the client has not heard of) reads as "This engine". */
  engineName?: string;
  onChange: (backend: CloudBackend) => void;
}) {
  const vpsNoteId = useId();
  const engineLabel = engineName?.trim() ? engineName.trim() : "This engine";
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[12px] font-medium text-ink">Cloud Backend</div>
      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
        {value === "vps"
          ? "Your own SSH-configured Linux host, with a separate desktop per bot on that one machine.  Auto reuses a running container by default; enable Start VPS automatically to let it create or wake one.  Open the live desktop securely from the computer panel."
          : "ASCII.dev Box is the default hosted computer, one per bot.  Choose Self-hosted VPS to run the desktops on your own server instead."}
      </div>
      <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
        {(["box", "vps"] as const).map((backend, i) => {
          const disabled = backend === "vps" && !vpsSupported;
          return (
            <button
              key={backend}
              disabled={disabled}
              aria-describedby={disabled ? vpsNoteId : undefined}
              onClick={() => onChange(backend)}
              className={cn(
                "flex-1 py-1.5 text-[12px]",
                i > 0 && "border-l border-hairline/40",
                disabled && "cursor-not-allowed opacity-40",
                value === backend
                  ? "bg-control text-ink font-medium"
                  : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {backend === "vps" ? "Self-hosted VPS" : "ASCII.dev Box"}
            </button>
          );
        })}
      </div>
      {!vpsSupported && (
        <div id={vpsNoteId} className="mt-2 text-[11.5px] text-ink-secondary">
          {`${engineLabel} can't run a desktop on your own server.\u00a0 Pick an engine that can control a computer, such as Claude, to use Self-hosted VPS.`}
        </div>
      )}
      {inherited && (
        <div className="mt-2 text-[11.5px] text-ink-secondary">
          This bot has not chosen one, so it follows the New Bots default in App Settings → Computers.  Picking
          either sets this bot's own, and it stops following.
        </div>
      )}
    </div>
  );
}
