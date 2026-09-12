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
