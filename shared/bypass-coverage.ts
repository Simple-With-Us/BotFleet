// What a bot's Bypass Permissions switch actually does on each engine, so the
// desktop and the phone can say so instead of showing a switch that quietly
// changes nothing.
//
// The switch lives on the bot (`bypassPermissions`), not on the engine.  It is
// applied in one of two places, and the engine decides which:
//
//   "asks"   The engine raises its approval requests to the harness broker
//            (server/index.ts `request.opened` -> `autoVerdict`), and a bot in
//            bypass has every one answered, except a request that controls
//            This Mac.  Claude, Codex, every ACP engine and the HTTP tool
//            lanes.
//   "native" The engine has a skip-approvals mode and NO broker path to carry
//            the bot's choice (Antigravity's print mode), so the driver turns
//            its own mode on for the turn, again never on one that controls
//            This Mac (server/drivers/antigravity.ts).
//   "none"   The engine never asks, so there is nothing for bypass to
//            answer: Box runs on its own computer, a wrapped CLI cannot
//            answer a permission request, and Pi runs its own tools without
//            one (only the host-control tools it mounts ask).
//
// An engine this table has not heard of is "asks": the broker answers whatever
// reaches it, and a new engine that never asks is a one-line addition here, not
// a reason for a phone to claim the switch is dead.
//
// The per-ENGINE autonomous-mode box (Settings > Engines, `fullAuto`) is a
// different switch, with its own list: `instanceAutonomousModeApplies`.

export type BypassCoverage = "asks" | "native" | "none";

const NO_ASKS = new Set(["boxAgent", "cli-wrapper", "piAgent"]);
const NATIVE_MODE = new Set(["antigravityAgent"]);

export function bypassCoverage(driverKind: string | undefined): BypassCoverage {
  if (!driverKind) return "asks";
  if (NO_ASKS.has(driverKind)) return "none";
  if (NATIVE_MODE.has(driverKind)) return "native";
  return "asks";
}

/** One sentence gap: a no-break space and a space, which survives HTML. */
const GAP = "  ";

/** The line to show under a bot's Bypass Permissions switch, or null when the
 * switch simply works as described (the engine asks, and the broker answers).
 * `src/components/SettingsPanel.tsx` and the iOS bot sheet
 * (`ios/Sources/CompanionCore/BotExecutionPolicy.swift`) say the same thing;
 * `companion/test/ios-client-parity.test.ts` checks the two agree. */
export function bypassCoverageNote(coverage: BypassCoverage): string | null {
  switch (coverage) {
    case "none":
      return "This engine never asks for approval, so Bypass Permissions changes nothing for it.";
    case "native":
      return `This engine has no approval cards.${GAP}Bypass Permissions turns on its skip-permissions mode for turns that do not control This Mac.`;
    case "asks":
      return null;
  }
}

/** Engines whose "Bypass permissions (autonomous mode)" box in Settings >
 * Engines (`fullAuto` on the instance) changes something.  Claude, Codex and
 * Antigravity map it to their own mode, Cursor, Grok and Droid to a CLI flag
 * or session mode, and the other ACP engines have the harness answer every ask
 * itself.  The HTTP tool lanes and Pi decode the key and never read it, and
 * Box and a wrapped CLI never ask, so on those the box is a no-op. */
const INSTANCE_BOX_IS_A_NO_OP = new Set([
  "boxAgent",
  "cli-wrapper",
  "piAgent",
  "minimax",
  "openai-compat",
  "grok",
]);

export function instanceAutonomousModeApplies(driverKind: string | undefined): boolean {
  return !driverKind || !INSTANCE_BOX_IS_A_NO_OP.has(driverKind);
}

export const INSTANCE_AUTONOMOUS_MODE_NO_OP_NOTE =
  `This engine has no autonomous mode of its own, so this box changes nothing.${GAP}Turn on Bypass Permissions on a bot instead.`;
