// A short list of "saved data needs attention" notices, kept for the life of
// the process and read by `GET /api/data-faults`, which the app turns into a
// banner.
//
// Why this exists: BotFleet used to treat a store file it could not read as
// "nothing there" and carry on, so the next save replaced the unreadable
// file with an empty one and the owner's roster, rooms, routines or settings
// were gone with no sign that anything had happened.  Now every place that
// meets an unusable file sets it aside (never deletes it), carries on with
// what it can read, and records a notice here so the state is obvious.
//
// A notice never carries a fragment of a file: `reason` is built from error
// codes, character positions and schema paths only, because config.json
// holds API keys and a JSON parser's own message quotes the text around the
// failure.
//
// Leaf module on purpose (node:fs and node:path only): config.ts, store.ts
// and routines.ts all import it, so it must import none of them.
import { readdirSync } from "node:fs";

export type DataFaultKind =
  /** The file could not be used.  It was moved aside and the store started without it. */
  | "set-aside"
  /** Some entries were unusable.  The whole original was copied aside and the rest kept. */
  | "partial"
  /** The file exists but could not be read, or could not be moved aside.  Saves to it are refused. */
  | "unreadable"
  /** config.json could not be used at all, so this run is on defaults. */
  | "config-ignored"
  /** Some sections of config.json were unusable and left out; the rest were kept. */
  | "config-partial"
  /** A set-aside copy from an earlier run is still in the data folder. */
  | "left-over";

export interface DataFault {
  /** The data file the notice is about, as a base name ("bots.json"). */
  file: string;
  kind: DataFaultKind;
  /** A short phrase that completes "<file> could not be used because ...".  Never file content. */
  reason: string;
  /** Base name of the preserved file, when there is one. */
  setAsideAs: string | null;
  /** How many entries were left out (kind "partial"). */
  omitted: number;
  /** Which config.json sections were left out (kind "config-partial"). */
  sections: string[];
  /** True when BotFleet is deliberately not saving to this file. */
  writesRefused: boolean;
  /** True when old-data cleanup is paused because of this notice. */
  holdsCleanup: boolean;
  /** Epoch milliseconds. */
  at: number;
}

const faults = new Map<string, DataFault>();

/** Record a notice.  One per file: a newer notice about the same file replaces the older one. */
export function recordDataFault(fault: DataFault): void {
  faults.set(fault.file, { ...fault, sections: [...fault.sections] });
}

/** Drop the notice for `file`, but only when it is one of `kinds` (any kind when omitted).
 * Config notices describe the file as it is now, so a clean read clears them; a "set-aside" notice
 * is history and must survive the clean read that follows it. */
export function clearDataFault(file: string, kinds?: readonly DataFaultKind[]): void {
  const current = faults.get(file);
  if (!current) return;
  if (kinds && !kinds.includes(current.kind)) return;
  faults.delete(file);
}

export function listDataFaults(): DataFault[] {
  return [...faults.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((fault) => ({ ...fault, sections: [...fault.sections] }));
}

/** Tests only: start from no notices. */
export function resetDataFaults(): void {
  faults.clear();
}

/** The names a set-aside file can have: `<store>.json.corrupt-<epoch ms>`, with `-<n>` appended
 * in the unlikely event two were made in the same millisecond. */
const SET_ASIDE_NAME = /^(bots|groups|routines|config)\.json\.corrupt-(\d+)(?:-\d+)?$/;

export interface SetAsideFile {
  /** Base name, e.g. "bots.json.corrupt-1790000000000". */
  name: string;
  /** The store it belongs to, e.g. "bots.json". */
  file: string;
  at: number;
}

/** Every set-aside file in `dataDir`, oldest first.  Read from disk on each call: this is what
 * keeps a quarantine in force across restarts, so it must not depend on anything in memory. */
export function findSetAsideFiles(dataDir: string): SetAsideFile[] {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  const found: SetAsideFile[] = [];
  for (const name of names) {
    const match = SET_ASIDE_NAME.exec(name);
    if (!match) continue;
    found.push({ name, file: `${match[1]}.json`, at: Number(match[2]) });
  }
  return found.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/** The stores whose contents decide which bots, rooms and threads still exist. */
export const ROSTER_FILES: readonly string[] = ["bots.json", "groups.json"];

/** True while a set-aside bots.json is waiting in `dataDir`.  Until the owner restores or removes
 * it, an empty or partial roster is not evidence that the bots were deleted. */
export function rosterIsOnHold(dataDir: string): boolean {
  return findSetAsideFiles(dataDir).some((entry) => entry.file === "bots.json");
}

/** Why the sweeps that delete "orphaned" workspaces, transcripts and message rows must not run
 * right now, or null when they may.  Those sweeps treat every bot and room missing from the
 * roster as deleted and remove its data once it is old enough, which is exactly wrong while the
 * real roster sits in a set-aside file.  Derived from disk each call, so it holds across
 * restarts, and from the live notices, which cover a file that could not be moved aside. */
export function cleanupHoldReason(dataDir: string): string | null {
  const waiting = findSetAsideFiles(dataDir).filter((entry) => ROSTER_FILES.includes(entry.file));
  const newest = waiting[waiting.length - 1];
  if (newest) {
    return `${newest.name} is waiting to be restored or removed, so the roster may be incomplete`;
  }
  const live = listDataFaults().find((fault) => fault.holdsCleanup);
  if (live) return `${live.file} needs attention, so the roster may be incomplete`;
  return null;
}

/** At startup, add a "left-over" notice for each store that has a set-aside file from an earlier
 * run and no fresher notice of its own.  This is what keeps the banner up after a restart. */
export function registerLeftOverSetAsideFiles(dataDir: string, now: number = Date.now()): void {
  const newestByFile = new Map<string, SetAsideFile>();
  for (const entry of findSetAsideFiles(dataDir)) {
    if (entry.file === "config.json") continue;
    newestByFile.set(entry.file, entry);
  }
  for (const [file, entry] of newestByFile) {
    if (faults.has(file)) continue;
    recordDataFault({
      file,
      kind: "left-over",
      reason: "an earlier problem with it",
      setAsideAs: entry.name,
      omitted: 0,
      sections: [],
      writesRefused: false,
      holdsCleanup: ROSTER_FILES.includes(file),
      at: now,
    });
  }
}
