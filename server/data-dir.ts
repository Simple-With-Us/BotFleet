// Where the server's own data lives on this machine.
//
// One rule, shared with the desktop app (electron/app-paths.mjs): OMB_DATA_DIR overrides
// ~/.botfleet when it holds anything but whitespace, and an empty or whitespace-only value is
// treated as unset.  The app trims for exactly this reason — a machine configured with
// `OMB_DATA_DIR=" /Volumes/External/botfleet "` must not have the app read the trimmed path
// while the server reads one with the padding in it.  Without the empty check `OMB_DATA_DIR=""`
// reaches `join("", …)` and produces a relative path against whatever cwd the process has.
import { homedir } from "node:os";
import { join } from "node:path";

/** The override, trimmed, or "" when it is unset or blank. */
export function dataDirOverride(value: string | undefined): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return dataDirOverride(env.OMB_DATA_DIR) || join(homedir(), ".botfleet");
}
