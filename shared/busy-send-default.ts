/** While a bot turn is busy, a person's send either joins the running turn
 * (`steer`) or waits in the steer-queue until the turn finishes (`queue`).
 * Steer-capable engines join in-process; others need a client interrupt when
 * the default is steer.  Each send may override the workspace default. */

export const BUSY_SEND_DEFAULTS = ["queue", "steer"] as const;
export type BusySendDefault = (typeof BUSY_SEND_DEFAULTS)[number];

/** Unset config keeps today's steer-first harness behavior. */
export const DEFAULT_BUSY_SEND_DEFAULT: BusySendDefault = "steer";

export function isBusySendDefault(value: unknown): value is BusySendDefault {
  return value === "queue" || value === "steer";
}

export function parseBusySendDefault(value: unknown): BusySendDefault {
  return isBusySendDefault(value) ? value : DEFAULT_BUSY_SEND_DEFAULT;
}

export function parseBusyDeliveryOverride(value: unknown): BusySendDefault | undefined {
  return isBusySendDefault(value) ? value : undefined;
}
