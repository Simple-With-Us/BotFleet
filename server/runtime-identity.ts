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
 * TypeError: X is not iterable (BOTFLEET-2M / Sentry 7768010831). */
export function sweepMapIfPresent<K, V>(
  value: Map<K, V> | null | undefined | unknown,
  shouldDelete: (key: K, entry: V) => boolean,
): number {
  if (!(value instanceof Map)) return 0;
  for (const [key, entry] of value as Map<K, V>) {
    if (shouldDelete(key, entry)) value.delete(key);
  }
  return value.size;
}
