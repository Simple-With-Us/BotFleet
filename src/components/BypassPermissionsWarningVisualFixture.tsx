// Test harness for tests/e2e/bypass-warning.visual.spec.ts.
//
// Mounts the real BypassPermissionsWarning dialog, open, with a fixed bot and
// model.  The dialog is the last stop before a bot runs commands and file edits
// with no confirmation card, so its three looks are pinned: a standard model
// (accent button, plain copy), a lightweight model (danger callout and the
// "I Understand the Risks" button), and the busy state (disabled buttons,
// "Applying…").  The variant comes from /?fixture=bypass-warning&variant=...,
// parsed against the exact vocabulary so an unknown value fails loudly.
import { z } from "zod";
import { BypassPermissionsWarning } from "./BypassPermissionsWarning";

const VariantSchema = z.enum(["standard", "dangerous", "busy"]).default("standard");

const MODELS = {
  standard: "claude-3-7-sonnet-20250219",
  dangerous: "claude-3-5-haiku-20241022",
  busy: "claude-3-5-haiku-20241022",
} as const;

const noop = () => {};

export default function BypassPermissionsWarningVisualFixture() {
  const raw = new URLSearchParams(window.location.search).get("variant") ?? undefined;
  const variant = VariantSchema.parse(raw);
  return (
    <div data-testid="bypass-warning-fixture" className="min-h-screen bg-app text-ink">
      <BypassPermissionsWarning
        open
        onCancel={noop}
        onConfirm={noop}
        botName="Fixer"
        model={MODELS[variant]}
        busy={variant === "busy"}
      />
    </div>
  );
}
