// The renderer's half of "saved data needs attention".
//
// When BotFleet meets a bots, rooms, routines or settings file it cannot use,
// it sets the file aside (never deletes it), carries on with what it can read,
// and records a notice (server/data-faults.ts).  This file fetches those
// notices and owns the words: the components own the markup.  Everything here
// is a fetch or a pure string, so the wording can be tested without rendering.
//
// An older server has no such route and answers 404 or an HTML page.  That is
// "nothing to report", never an error, and a failed fetch is the same: a
// banner about a banner would be worse than none.
import { useEffect, useState } from "react";
import { z } from "zod";

import { DATA_FAULT_KINDS, type DataFault } from "../../shared/data-fault";

/** The gap protocol's wide sentence break, for copy a person reads. */
const GAP = "  ";

const faultSchema: z.ZodType<DataFault> = z.object({
  file: z.string(),
  kind: z.enum(DATA_FAULT_KINDS),
  reason: z.string(),
  setAsideAs: z.string().nullable(),
  omitted: z.number(),
  sections: z.array(z.string()),
  writesRefused: z.boolean(),
  holdsCleanup: z.boolean(),
  at: z.number(),
});
const responseSchema = z.object({ faults: z.array(faultSchema) });

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function fetchDataFaults(request: Fetcher = fetch): Promise<DataFault[]> {
  try {
    const response = await request("/api/data-faults");
    if (!response.ok) return [];
    const parsed = responseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.faults : [];
  } catch {
    return [];
  }
}

/** Identity of the set of notices on screen, so a dismissal holds until something changes. */
export function dataFaultsKey(faults: readonly DataFault[]): string {
  return faults.map((fault) => `${fault.file}:${fault.kind}:${fault.setAsideAs ?? ""}:${fault.omitted}:${fault.sections.join(",")}`).join("|");
}

/** True when anything is being refused: the notice then reads as an error, not a warning. */
export function dataFaultsAreUrgent(faults: readonly DataFault[]): boolean {
  return faults.some((fault) => fault.writesRefused);
}

function subject(file: string): string {
  switch (file) {
    case "bots.json":
      return "your bot list";
    case "groups.json":
      return "your rooms";
    case "routines.json":
      return "your routines";
    case "config.json":
      return "your settings";
    default:
      return "some saved data";
  }
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const cleanupPaused = (condition: string): string =>
  `Automatic cleanup of old workspaces and transcripts stays paused ${condition}, so nothing they hold is removed.`;

/** The bold first sentence of a notice. */
export function dataFaultLead(fault: DataFault): string {
  const what = capitalized(subject(fault.file));
  switch (fault.kind) {
    case "set-aside":
      return `${what} could not be read.`;
    case "partial":
      return `Part of ${subject(fault.file)} could not be read.`;
    case "unreadable":
      return `${what} could not be opened, and changes to it are not being saved.`;
    case "config-ignored":
      return `${what} could not be read, so BotFleet is using defaults.`;
    case "config-partial":
      return "Some of your settings could not be used.";
    case "left-over":
      return `A copy of ${subject(fault.file)} from an earlier problem is still set aside.`;
  }
}

/** The rest of the notice, one sentence per entry.  Never a fragment of a file. */
export function dataFaultSentences(fault: DataFault): string[] {
  const file = fault.file;
  const copy = fault.setAsideAs ?? "a set-aside file";
  const restore = `To restore it, quit BotFleet, repair that file, put it back as ${file}, and open BotFleet again.`;
  switch (fault.kind) {
    case "set-aside": {
      if (file === "config.json") {
        return [
          `BotFleet could not use ${file} because ${fault.reason}.`,
          `It was moved to ${copy} in your BotFleet data folder, and your last change was saved into a new file.`,
          "Nothing was deleted.",
          "Settings that were only in the old file are not in effect until you copy them across.",
        ];
      }
      return [
        `BotFleet could not use ${file} because ${fault.reason}.`,
        `It was moved to ${copy} in your BotFleet data folder, and BotFleet started without it.`,
        "Nothing was deleted.",
        restore,
        ...(fault.holdsCleanup ? [cleanupPaused("while it is there")] : []),
      ];
    }
    case "partial": {
      const entries = fault.omitted === 1 ? "entry" : "entries";
      return [
        `${fault.omitted} ${entries} in ${file} could not be read and ${fault.omitted === 1 ? "was" : "were"} left out.`,
        fault.setAsideAs
          ? `The whole original is saved as ${copy} in your BotFleet data folder.`
          : "A copy of the original could not be saved.",
        ...(fault.writesRefused
          ? [`BotFleet is not saving changes to ${file} until this is fixed.`]
          : ["Nothing was deleted."]),
        ...(fault.holdsCleanup ? [cleanupPaused("while it is there")] : []),
      ];
    }
    case "unreadable":
      return [
        `BotFleet could not use ${file} because ${fault.reason}.`,
        "It was left where it is, so changes made now are kept only until BotFleet quits.",
        "Fix or move that file, then open BotFleet again.",
        ...(fault.holdsCleanup ? [cleanupPaused("until it is fixed")] : []),
      ];
    case "config-ignored":
      return [
        `BotFleet could not use ${file} because ${fault.reason}.`,
        "The file has not been changed.",
        "Fix it and open BotFleet again.",
        "If you change a setting first, BotFleet keeps the old file under a new name and starts a fresh one.",
      ];
    case "config-partial":
      return [
        `These were left out of ${file}: ${fault.sections.join(", ")}.`,
        "Everything else in the file is in use.",
        "The file has not been changed.",
      ];
    case "left-over":
      return [
        `${copy} is a set-aside copy in your BotFleet data folder.`,
        "When you have restored it, or no longer need it, move it out of that folder and this notice goes away.",
        ...(fault.holdsCleanup ? [cleanupPaused("while it is there")] : []),
      ];
  }
}

/** One notice as the banner prints it. */
export interface DataFaultText {
  /** The bold first sentence. */
  lead: string;
  /** The rest, with the wide gap between sentences. */
  body: string;
}

export function dataFaultText(fault: DataFault): DataFaultText {
  return { lead: dataFaultLead(fault), body: dataFaultSentences(fault).join(GAP) };
}

function sameFaults(a: readonly DataFault[], b: readonly DataFault[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The notices now in force.  Fetched on mount and whenever the window regains focus, because the
 * file that caused one can be fixed (or break) while the app is open. */
export function useDataFaults(): DataFault[] {
  const [faults, setFaults] = useState<DataFault[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void fetchDataFaults().then((next) => {
        if (alive) setFaults((previous) => (sameFaults(previous, next) ? previous : next));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return faults;
}
