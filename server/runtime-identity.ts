import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashStaticUi, readPackagedBuildIdentity, readSourceBuildIdentity, type BuildIdentity } from "../electron/runtime-identity.mjs";

// A bundle has an adjacent manifest.  Source execution pins git identity at
// module load; no request re-reads HEAD after an updater moves the checkout.
const directory = dirname(fileURLToPath(import.meta.url));
const sourceIdentity: BuildIdentity = import.meta.url.endsWith(".ts")
  ? readSourceBuildIdentity(join(directory, ".."))
  : readPackagedBuildIdentity(directory);
export const runtimeBuildIdentity = { ...sourceIdentity, uiHash: hashStaticUi(process.env.OMB_STATIC_DIR) };

export function runtimeReadiness(counts: Record<string, number>) {
  const values = Object.values(counts);
  const valid = values.every((count) => Number.isSafeInteger(count) && count >= 0);
  const activeWorkCount = valid ? values.reduce((total, count) => total + count, 0) : null;
  return { safeToRestart: activeWorkCount === 0, activeWorkCount };
}

/** Walk a Map that might not exist yet (boot race) and drop stale entries.
 * Returns the surviving size, or 0 when `value` is not a Map — never throws
 * TypeError: X is not iterable (BOTFLEET-2M / Sentry 7768010831).
 *
 * Overloads keep `V` from a typed Map (so callbacks see `round.threadId`, not
 * `unknown`). The `unknown` overload covers the defensive non-Map belt. */
export function sweepMapIfPresent<K, V>(
  value: Map<K, V>,
  shouldDelete: (key: K, entry: V) => boolean,
): number;
export function sweepMapIfPresent(
  value: null | undefined | unknown,
  shouldDelete?: (key: unknown, entry: unknown) => boolean,
): number;
export function sweepMapIfPresent<K, V>(
  value: Map<K, V> | null | undefined | unknown,
  shouldDelete?: (key: K, entry: V) => boolean,
): number {
  if (!(value instanceof Map)) return 0;
  const map = value as Map<K, V>;
  const drop = shouldDelete ?? (() => false);
  for (const [key, entry] of map) {
    if (drop(key, entry)) map.delete(key);
  }
  return map.size;
}
