// VPS mode control: shared (one container for the whole workspace),
// per-bot (each bot that has the VPS in its grant gets its own private
// container + durable workspace), and "not used" (the operator has
// decided not to enable the VPS provider, so the mode is moot).  The
// button row is the same visual idiom as the legacy VM-mode picker in
// `LocalComputerSection.tsx` so the settings panel keeps a consistent
// look.  Behavior lives in the parent: the parent computes the next
// value, calls `onChange`, and re-reads `state.config` for the
// confirmation message — this component does not own the dispatch.
import { cn } from "@/lib/cn";
import type { VpsMode } from "../../shared/local-auto-consent";

export type VpsModeToggleProps = {
  value: VpsMode;
  busy?: boolean;
  onChange: (next: VpsMode) => void;
};

const OPTIONS: ReadonlyArray<{ value: VpsMode; label: string; aria: string }> = [
  { value: "shared", label: "Shared", aria: "Shared VPS — one container for every bot" },
  { value: "per-bot", label: "Per-Bot", aria: "Per-bot VPS — one container and workspace each" },
  { value: null, label: "Not Used", aria: "VPS off" },
];

const CAPTION: Record<"shared" | "per-bot", string> = {
  shared: "Shared VPS is one container for every bot — each bot gets its own isolated desktop session inside it.\u00a0 Several bots can use it at the same time.",
  "per-bot": "Per-bot VPS gives each bot a private container, durable workspace, and loopback viewer.\u00a0 Idle desktops stop on their own after 8 hours.",
};

export function VpsModeToggle({ value: stored, busy, onChange }: VpsModeToggleProps) {
  const value: VpsMode = stored;
  return (
    <div className="flex flex-col gap-1.5" data-testid="vps-mode-toggle">
      <div className="flex overflow-hidden rounded-lg border border-hairline/40">
        {OPTIONS.map((option, i) => {
          const active = value === option.value;
          return (
            <button
              key={option.label}
              type="button"
              aria-label={option.aria}
              aria-pressed={active}
              disabled={busy}
              onClick={() => onChange(option.value)}
              className={cn(
                "flex-1 py-1.5 text-[13px]",
                i > 0 && "border-l border-hairline/40",
                busy && "opacity-60",
                active ? "bg-control text-ink font-medium" : "text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {value !== null && (
        <p className="text-[11.5px] leading-relaxed text-ink-secondary">{CAPTION[value]}</p>
      )}
    </div>
  );
}
