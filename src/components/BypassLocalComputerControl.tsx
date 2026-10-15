import { cn } from "@/lib/cn";

/** The warning in front of Bypass Including This Mac.  The dialog is the
 *  Auto Mode one; the name is this switch's, so neither gets a quieter path. */
export const BYPASS_LOCAL_COMPUTER_WARNING_TITLE = "Allow Bypass Including This Mac?";

export const BYPASS_LOCAL_COMPUTER_WARNING_BODY =
  "Nothing this bot does on this Mac will ask again \u2014 including destructive actions and credential files, and including while a webhook or alert runs it with nobody watching.\u00a0 Continue only if you would trust it with the machine itself.";

/** The second switch under Bypass Permissions.  It stays disabled until
 *  Bypass itself is on, because the flag only extends what Bypass already skips. */
export function BypassLocalComputerControl({
  bypassPermissions,
  bypassLocalComputer,
  onTurnOff,
  onRequestOn,
}: {
  bypassPermissions: boolean;
  bypassLocalComputer: boolean;
  onTurnOff: () => void;
  onRequestOn: () => void;
}) {
  return (
    <>
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-line pt-4">
        <div>
          <div className="text-[15px] font-medium text-ink">
            Bypass Including This Mac
          </div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {bypassLocalComputer
              ? "Nothing this bot does on this Mac asks.\u00a0 Including destructive actions, and including while a webhook or alert runs it with nobody watching."
              : "Off.\u00a0 Bypass still stops before anything that controls this Mac."}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={bypassLocalComputer}
          aria-label="Bypass Including This Mac"
          disabled={!bypassPermissions}
          onClick={() => {
            if (bypassLocalComputer) onTurnOff();
            else onRequestOn();
          }}
          className={cn(
            "relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors",
            !bypassPermissions && "cursor-not-allowed opacity-50",
            bypassLocalComputer ? "bg-danger" : "bg-control",
          )}
        >
          <span
            className={cn(
              "absolute top-[3px] size-5 rounded-full bg-white transition-all",
              bypassLocalComputer ? "left-[21px]" : "left-[3px]",
            )}
          />
        </button>
      </div>
      {!bypassPermissions && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          Turn on Bypass Permissions first — this only extends what Bypass already skips.
        </div>
      )}
    </>
  );
}
