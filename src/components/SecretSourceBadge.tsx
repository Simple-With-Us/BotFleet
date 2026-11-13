// Per-field provenance chip for a mapped credential: a dot, a sentence-case
// label, and — only when Infisical actually holds the value — a lock glyph
// with a title explaining why the input beside it is disabled.  Renders
// nothing when Infisical is unconfigured and the source is "file", so an
// install with no vault at all sees no new chrome next to its keys.
import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { secretSourceDisplay, type SecretSource } from "@/lib/secret-source";

export function SecretSourceBadge({
  source,
  infisicalConfigured,
  elsewhere,
  className,
}: {
  source: SecretSource | undefined;
  /** Whether this install has a vault connected at all — from
   * `state.config?.infisical?.configured`. */
  infisicalConfigured: boolean;
  /** A file outside BotFleet that holds this value, when nothing BotFleet
   * manages does — `~/.mmx/config.json` for the MiniMax key. */
  elsewhere?: string | null;
  className?: string;
}) {
  if (!infisicalConfigured && !elsewhere && (source === "file" || source === undefined)) return null;

  const { label, tone, external } = secretSourceDisplay(source, elsewhere);
  const managed = tone === "managed";

  return (
    <span
      title={
        managed
          ? "Managed by Infisical.  Change it in Infisical, or turn on Write Through."
          : external
            ? "Read by the engine itself.  Save a key in Settings, the environment, or Infisical to manage it here."
            : undefined
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium",
        external ? "font-mono normal-case" : "uppercase tracking-wide",
        tone === "managed" && "bg-accent/15 text-accent",
        tone === "environment" && "bg-warning/15 text-warning",
        tone === "local" && "bg-inset text-ink-secondary",
        tone === "unset" && "bg-inset text-ink-secondary/70",
        className,
      )}
    >
      {managed && <Lock size={10} aria-hidden="true" />}
      {label}
    </span>
  );
}
