/** How a busy-turn send should be delivered.  Absent means the engine default. */
export type BusyDelivery = "steer" | "queue";

/** Reject anything other than the two delivery words.  Absent is allowed. */
export function parseBusyDelivery(value: unknown): BusyDelivery | undefined {
  if (value === undefined) return undefined;
  if (value === "steer" || value === "queue") return value;
  throw Object.assign(new Error("delivery must be steer or queue"), { status: 400 });
}

/**
 * Whether this busy send should call the engine's live steer.
 * An explicit queue never does, even when the engine can fold text into
 * the running turn.  Anything else follows the engine.
 */
export function wantsLiveSteer(delivery: BusyDelivery | undefined, engineCanSteer: boolean): boolean {
  if (delivery === "queue") return false;
  return engineCanSteer;
}
