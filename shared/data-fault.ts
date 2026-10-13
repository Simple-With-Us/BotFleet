// One notice that saved data needs attention, as the server records it and
// the app shows it.  See server/data-faults.ts for how they are raised and
// src/lib/data-faults.ts for the words the app puts around them.
//
// A notice never carries a fragment of a file: `reason` is built from error
// codes, character positions and schema paths only, because config.json
// holds API keys and a JSON parser's own message quotes the text around the
// failure.

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

export const DATA_FAULT_KINDS: readonly DataFaultKind[] = [
  "set-aside",
  "partial",
  "unreadable",
  "config-ignored",
  "config-partial",
  "left-over",
];

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
