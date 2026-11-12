/** While a bot turn is busy, a person's send either joins the running turn
 * (`steer`) or waits in the steer-queue until the turn finishes (`queue`).
 * Steer-capable engines join in-process; others need a client interrupt when
 * the default is steer.  Each send may override the workspace default. */

export type BusySendDefault = "queue" | "steer";
export const BUSY_SEND_DEFAULTS = ["queue", "steer"] as const satisfies readonly BusySendDefault[];

/** Unset config lets the in-flight reply finish: the send waits in the
 * steer-queue until the bot settles, then runs as the next turn.  Steer stays
 * reachable as a per-workspace or per-send choice for the times interrupting is
 * what you actually want.  It was the default until BF-2442 — owner report
 * 2026-10-16 that every new message cut the previous reply off mid-sentence,
 * which reads worst aloud because a truncated clause has no clean stop point.
 * A workspace that explicitly chose `steer` keeps it; only the unset case
 * changed. */
export const DEFAULT_BUSY_SEND_DEFAULT: BusySendDefault = "queue";

/** Config and wire values before validation. */
export type BusySendDefaultInput = BusySendDefault | string | null | undefined;

export function isBusySendDefault(value: BusySendDefaultInput): value is BusySendDefault {
  return value === "queue" || value === "steer";
}

export function parseBusySendDefault(value: BusySendDefaultInput): BusySendDefault {
  return isBusySendDefault(value) ? value : DEFAULT_BUSY_SEND_DEFAULT;
}

export function parseBusyDeliveryOverride(value: BusySendDefaultInput): BusySendDefault | undefined {
  return isBusySendDefault(value) ? value : undefined;
}

/** Client-side: interrupt only when steer delivery needs to stop a non-steer-capable turn. */
export function shouldInterruptForBusySteer(
  busy: boolean,
  busyDelivery: BusySendDefault | undefined,
  canSteer: boolean,
): boolean {
  return busy && busyDelivery === "steer" && !canSteer;
}
