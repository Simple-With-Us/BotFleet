/**
 * Where a routine / webhook / resource trigger runs.
 *
 * `bot` = this BotFleet setup (local provider + optional computer tools).
 * `cloud` = the bot's Box / VPS cloud desktop.
 *
 * Disk and older clients may still say `maus` for the local destination.
 * Normalize on read so every write persists `bot`.
 */
export type RoutineRunOn = "bot" | "cloud";

/** Wire / disk values we still accept before normalizing to RoutineRunOn. */
export type LegacyRoutineRunOn = RoutineRunOn | "maus";

export function normalizeRunOn(
  value: unknown,
  fallback: RoutineRunOn = "bot",
): RoutineRunOn {
  if (value === "cloud") return "cloud";
  if (value === "bot" || value === "maus") return "bot";
  return fallback;
}

export function isRoutineRunOn(value: unknown): value is RoutineRunOn {
  return value === "bot" || value === "cloud";
}
