// Per-provider enable/disable toggle for the redesigned Computer settings
// UI.  The on-disk shape is `ComputerProviders` (a 4-key boolean map in
// `shared/local-auto-consent.ts`); each toggle here is one of those keys.
// Visual treatment: a wide colored "pill" button — accent green when the
// provider is on, neutral grey when off — with a small caption below
// describing what flipping it off would do to existing bot grants.  The
// caption is the only place we explain the impact, so the user does not
// have to open a modal to learn what they are about to lose.
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ComputerProviderId } from "../../shared/local-auto-consent";
import {
  COMPUTER_PROVIDER_DISABLE_IMPACT,
  COMPUTER_PROVIDER_LABEL,
} from "../../shared/local-auto-consent";

export type ComputerProviderToggleProps = {
  provider: ComputerProviderId;
  enabled: boolean;
  /** Override the default "what toggling off would do" caption. */
  caption?: string;
  /** Set when the parent is mid-save, so the button shows a disabled
   * state without needing a separate spinner. */
  busy?: boolean;
  onToggle: (next: boolean) => void;
};

/** One row in the Providers card.  Kept dumb — the parent owns the
 * enabled state and the dispatch, and decides whether to open the
 * impact-confirm modal before committing the change. */
export function ComputerProviderToggle({
  provider,
  enabled,
  caption,
  busy,
  onToggle,
}: ComputerProviderToggleProps) {
  const label = COMPUTER_PROVIDER_LABEL[provider];
  const impactCaption = caption ?? COMPUTER_PROVIDER_DISABLE_IMPACT[provider];
  return (
    <div className="flex flex-col gap-1.5" data-testid={`provider-toggle-${provider}`}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        disabled={busy}
        onClick={() => onToggle(!enabled)}
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-[13px] font-medium transition-colors",
          "disabled:opacity-50",
          enabled
            ? "border-accent/50 bg-accent/10 text-accent hover:bg-accent/15"
            : "border-hairline/40 bg-control text-ink-secondary hover:bg-raised-hover hover:text-ink",
        )}
      >
        <span className="truncate">{label}</span>
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full text-white",
            enabled ? "bg-accent" : "bg-hairline/60",
          )}
        >
          {enabled ? <Check size={12} /> : null}
        </span>
      </button>
      <p className="text-[11.5px] leading-relaxed text-ink-secondary">{impactCaption}</p>
    </div>
  );
}