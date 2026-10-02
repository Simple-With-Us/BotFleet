// Load a JSON store file without ever letting a bad file turn into an empty
// store that the next save makes permanent.
//
// The old pattern, in bots.json, groups.json and routines.json alike, was
// `try { parse } catch { start empty }`.  The empty in-memory state was then
// the source of the next write, so one bad byte became an empty roster on
// disk (audit A7).  The rules here are:
//
//   * Only a missing file (ENOENT) means "first run".  Anything else that
//     stops the file being used is a fault, and a fault is made visible.
//   * An unusable file is MOVED ASIDE to `<name>.corrupt-<epoch ms>`, never
//     deleted and never overwritten, so the store can start fresh without
//     destroying the evidence or the owner's chance to repair it.
//   * If a file cannot be moved aside (or cannot be read at all), it stays
//     where it is and BotFleet refuses to save over it.  That is the only
//     case in which saving stops, and the notice says so.
//   * A byte-order mark is not damage: it is stripped and the file is used.
//   * When a list holds some usable entries and some not, the usable ones are
//     kept and the whole original is COPIED aside first, so what is left out
//     is still on disk.
//
// Every fault is logged once at the moment it is found and recorded in
// data-faults.ts for the app's banner.  Nothing logged or recorded here ever
// contains a fragment of the file.
import { constants, copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { ROSTER_FILES, recordDataFault, type DataFault } from "./data-faults.ts";
import { parseJson, type JsonValue } from "./schema.ts";

/** Drop a leading byte-order mark.  Some editors add one when a person fixes a file by hand. */
export function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

/** The error code of a failed file operation ("EACCES"), or a plain stand-in. */
export function fsFailureCode(error: Error): string {
  return "code" in error && error.code ? String(error.code) : "unknown error";
}

/** Why JSON.parse failed, in words that are safe to log.  The parser's own message quotes the text
 * around the failure, and config.json holds API keys, so only its position is ever used. */
export function jsonFailureReason(error: Error): string {
  const message = error.message;
  if (/end of JSON input|unterminated/i.test(message)) return "it ends early (it looks cut short)";
  const at = /position (\d+)/.exec(message)?.[1];
  return at ? `it is not valid JSON (near character ${at})` : "it is not valid JSON";
}

export type SetAside = { ok: true; path: string | null } | { ok: false; reason: string };

/** Move (or copy) `path` to a name beside it that does not exist yet.  Never overwrites and never
 * deletes: the source is renamed, so its mode and contents survive intact.  `path: null` means the
 * file was already gone, which happens when another BotFleet process set it aside first. */
export function setFileAside(path: string, how: "move" | "copy", now: number = Date.now()): SetAside {
  const dir = dirname(path);
  const name = basename(path);
  let target = join(dir, `${name}.corrupt-${now}`);
  for (let n = 1; existsSync(target); n += 1) target = join(dir, `${name}.corrupt-${now}-${n}`);
  try {
    if (how === "move") renameSync(path, target);
    else copyFileSync(path, target, constants.COPYFILE_EXCL);
    return { ok: true, path: target };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const code = fsFailureCode(failure);
    if (how === "move" && code === "ENOENT") return { ok: true, path: null };
    return { ok: false, reason: `it could not be ${how === "move" ? "moved aside" : "copied aside"} (${code})` };
  }
}

export type Interpreted<T> = { ok: true; value: T; omitted: number } | { ok: false; reason: string };

export interface GuardedLoad<T> {
  /**
   * missing: there is no file, so this is a first run.
   * ok: the file was usable (see `omitted` in the notice when entries were left out).
   * set-aside: the file was unusable and has been moved aside.
   * unreadable: the file was left in place, and `writesRefused` is true.
   */
  status: "missing" | "ok" | "set-aside" | "unreadable";
  value: T | null;
  /** True when saving to this file would destroy the only copy of something. */
  writesRefused: boolean;
}

function holdsCleanup(file: string): boolean {
  return ROSTER_FILES.includes(file);
}

function notice(path: string, partial: Pick<DataFault, "kind" | "reason" | "setAsideAs" | "omitted" | "writesRefused">, now: number): void {
  const file = basename(path);
  recordDataFault({ file, sections: [], holdsCleanup: holdsCleanup(file), at: now, ...partial });
}

/**
 * Read `path` and turn it into a store value, or set it aside.  `interpret` receives the parsed JSON
 * and returns the value (with a count of entries it had to leave out) or the reason the file's shape
 * is unusable.  See the file comment for what happens in each case.
 */
export function loadGuarded<T>(
  path: string,
  interpret: (parsed: JsonValue) => Interpreted<T>,
  now: number = Date.now(),
): GuardedLoad<T> {
  const file = basename(path);

  const leaveInPlace = (reason: string): GuardedLoad<T> => {
    console.error(
      `store: ${path} could not be used because ${reason}.  It was left where it is, and BotFleet will not save to it, so changes to ${file} made in this run are not being kept.  Fix or move the file, then restart BotFleet.`,
    );
    notice(path, { kind: "unreadable", reason, setAsideAs: null, omitted: 0, writesRefused: true }, now);
    return { status: "unreadable", value: null, writesRefused: true };
  };

  const setAside = (reason: string): GuardedLoad<T> => {
    const moved = setFileAside(path, "move", now);
    if (!moved.ok) return leaveInPlace(`${reason}, and ${moved.reason}`);
    const to = moved.path;
    console.error(
      `store: ${path} could not be used because ${reason}.  ${to ? `Moved it to ${to}` : "It has already been moved aside"} and started without it.  Nothing was deleted.  To restore it, quit BotFleet, repair that file, put it back as ${file}, and start BotFleet again.`,
    );
    notice(path, { kind: "set-aside", reason, setAsideAs: to ? basename(to) : null, omitted: 0, writesRefused: false }, now);
    return { status: "set-aside", value: null, writesRefused: false };
  };

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const code = fsFailureCode(failure);
    if (code === "ENOENT") return { status: "missing", value: null, writesRefused: false };
    return leaveInPlace(`it could not be read (${code})`);
  }

  const body = stripBom(text);
  if (body.trim() === "") return setAside("it is empty");

  let parsed: JsonValue;
  try {
    parsed = parseJson(body);
  } catch (error) {
    return setAside(jsonFailureReason(error instanceof Error ? error : new Error(String(error))));
  }

  const result = interpret(parsed);
  if (!result.ok) return setAside(result.reason);
  if (result.omitted === 0) return { status: "ok", value: result.value, writesRefused: false };

  const entries = result.omitted === 1 ? "entry" : "entries";
  const copied = setFileAside(path, "copy", now);
  if (!copied.ok) {
    const reason = `${result.omitted} ${entries} could not be read, and ${copied.reason}`;
    console.error(
      `store: ${path} has ${result.omitted} ${entries} BotFleet could not read, and the original could not be saved aside, so BotFleet will not save to ${file}.  Fix or move the file, then restart BotFleet.`,
    );
    notice(path, { kind: "partial", reason, setAsideAs: null, omitted: result.omitted, writesRefused: true }, now);
    return { status: "ok", value: result.value, writesRefused: true };
  }
  const to = copied.path;
  console.error(
    `store: ${result.omitted} ${entries} in ${path} could not be read and ${result.omitted === 1 ? "was" : "were"} left out.  The whole original is saved as ${to}.  Nothing was deleted.`,
  );
  notice(
    path,
    { kind: "partial", reason: `${result.omitted} ${entries} could not be read`, setAsideAs: to ? basename(to) : null, omitted: result.omitted, writesRefused: false },
    now,
  );
  return { status: "ok", value: result.value, writesRefused: false };
}

/** Log, once per file per run, that a save was skipped because the file is being protected. */
const refusalsLogged = new Set<string>();
export function logRefusedSave(path: string): void {
  if (refusalsLogged.has(path)) return;
  refusalsLogged.add(path);
  console.error(
    `store: not saving ${path}: it could not be read or set aside at startup, so writing it would destroy the only copy.  Changes are being kept in memory only.  Fix or move the file, then restart BotFleet.`,
  );
}

/** Tests only. */
export function resetRefusedSaveLog(): void {
  refusalsLogged.clear();
}
