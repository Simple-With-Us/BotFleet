// Bounds on the two per-thread transcript logs.  Both are append-only and,
// until this file, nothing ever trimmed them:
//
//   native/<threadId>.ndjson  — every provider protocol frame, verbatim
//                               (server/drivers/native.ts)
//   events/<threadId>.ndjson  — the normalized RuntimeEvent stream
//                               (server/harness/bus.ts)
//
// On the owner's Mac that reached 1.93 GB, 1.68 GB and 1.58 GB for three
// threads, roughly 6 GB across the directory, while the only reader —
// server/thread-events.ts, behind the Inspector panel — ever looks at the
// newest few hundred lines.  The rest is disk, backup volume and standing
// risk: a 35.7 MB routines.json rewritten on every save was enough to stall
// the harness event loop under swap pressure on 2026-09-12, and these files
// are two orders of magnitude larger than that one was.
//
// The rule is a byte cap per file, enforced by rotation.  When an append
// would carry the live log past its cap the log is renamed to
// `<threadId>.ndjson.1` and a fresh one starts, so a thread costs at most two
// caps on disk and the tail reader spans both generations.  A startup sweep
// applies the same cap to whatever the last run left behind, keeping the
// newest whole lines.  Nothing is deleted, no record shape changes, and a
// record written just after a rotation is byte-for-byte the record that would
// have been written without one.
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { appendFile, rename as renameFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Cap for `native/<threadId>.ndjson`.  The native tee is the chatty half —
 * it carries every provider frame verbatim, whole file contents a tool read
 * included — and it is what the Inspector's raw lens reads.  64 MB is a few
 * hundred thousand frames, two orders of magnitude more than the panel's
 * 2,000-line ceiling will ever ask for, and caps a thread at 128 MB across
 * both generations. */
export const NATIVE_LOG_MAX_BYTES = 64 * 1024 * 1024;

/** Cap for `events/<threadId>.ndjson`.  The runtime stream is normalized and
 * several times smaller than the native tee beside it — the largest on the
 * owner's Mac is 22 MB against a 1.93 GB native sibling — so a quarter of the
 * native cap still keeps far more history than the panel shows. */
export const EVENTS_LOG_MAX_BYTES = 16 * 1024 * 1024;

/** Cap for `item-io/<threadId>.ndjson`, the side store of tool inputs, tool
 * outputs and injected context (server/item-io-store.ts).  Each field is
 * already cut to 32 KB, so 6 MB is a few hundred steps of full-size payloads
 * or several thousand ordinary ones, and a thread costs at most two of them on
 * disk.  Older steps simply answer "not recorded" once they rotate out. */
export const ITEM_IO_LOG_MAX_BYTES = 6 * 1024 * 1024;

/** The one rotated generation kept beside a live log. */
export const ROTATED_SUFFIX = ".1";

const COPY_CHUNK = 64 * 1024;

/** The positional five-argument `readSync`, the only form this module uses.
 * Named so the seam below is one concrete signature rather than the whole
 * overloaded builtin. */
type ReadAt = (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
const DAILY_SWEEP_MS = 24 * 60 * 60 * 1000;

/** A trim writes its kept tail to `<file>.<pid>.<uuid>.tmp` and renames it
 * over the original.  A SIGKILL or a power loss between those two steps
 * leaves the temp file behind with nothing to reclaim it, so the sweep does:
 * a temp file whose writer is gone, or that is older than an hour, is not a
 * trim in flight.  Group 1 is the thread id prefix (`<threadId>.ndjson[.1]`
 * minus the `.ndjson`/`.ndjson.1` suffix), group 2 the pid — the orphan sweep
 * below reads group 1 to fold a stray temp file into the thread it belongs
 * to; `sweepTranscriptLogs` reads group 2 for `reapStaleTemp`. */
const TEMP_NAME = /^(.+)\.ndjson(?:\.1)?\.(\d{1,10})\.[0-9a-f-]{36}\.tmp$/;
const STALE_TEMP_MS = 60 * 60 * 1000;

/** Live byte counts, so the cap costs an arithmetic compare per append rather
 * than a stat(2) per line.  The first append to a path pays one stat; every
 * one after that adds the bytes it just wrote.  Bounded like the reader's
 * line-count cache: a long-lived harness sees many threads, and a stale entry
 * costs one extra stat, never correctness. */
const liveSizes = new Map<string, number>();
const SIZE_CACHE_MAX = 512;

function rememberSize(file: string, size: number): void {
  liveSizes.delete(file);
  liveSizes.set(file, size);
  while (liveSizes.size > SIZE_CACHE_MAX) liveSizes.delete(liveSizes.keys().next().value!);
}

/** Path of the rotated generation of `file`. */
export function rotatedPath(file: string): string {
  return `${file}${ROTATED_SUFFIX}`;
}

/** Both generations of a thread's log, newest first. */
export function transcriptLogPaths(dir: string, threadId: string): string[] {
  const live = join(dir, `${threadId}.ndjson`);
  return [live, rotatedPath(live)];
}

/** True when `pid` names a process that still exists.  A pid this process may
 * not signal answers EPERM, which is still alive; ESRCH is gone.  `TEMP_NAME`
 * already bounds the digits to ten, so the int32 range `process.kill` accepts
 * is the only thing left to check — outside it, and for any other argument
 * complaint, the answer is "not a live writer" rather than a throw out of the
 * boot sweep. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: read as a possible system error and nothing more — a value with
    // no `code`, or a code that is not EPERM (ESRCH, ERR_INVALID_ARG_TYPE, or
    // anything Node adds later), answers "not alive".
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** Everything a thread owns in `dir` — both generations, plus any temp file a
 * trim of either left behind — so a deleted bot or room leaves nothing on
 * disk.  Best-effort per file: a delete never fails because a log was not
 * there.  Returns how many files were removed. */
export function removeTranscriptLogs(dir: string, threadIds: Iterable<string>): number {
  const ids = [...threadIds];
  let removed = 0;
  for (const threadId of ids) {
    for (const file of transcriptLogPaths(dir, threadId)) {
      liveSizes.delete(file);
      try {
        unlinkSync(file);
        removed += 1;
      } catch {
        // not there, which is the ordinary case for a rotated generation
      }
    }
  }
  // One listing for every thread being removed, not one per thread: a room
  // with many tasks deletes them all at once.
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  const prefixes = ids.map((threadId) => `${threadId}.ndjson`);
  for (const name of names) {
    if (!TEMP_NAME.test(name) || !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      /* best-effort cleanup */
    }
  }
  return removed;
}

function currentSize(file: string): number {
  const cached = liveSizes.get(file);
  if (cached !== undefined) return cached;
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Rename the live log over the one rotated generation.  Returns false when
 * the rename did not happen — a file deleted under us, or a platform that
 * refuses to replace an open target — in which case the caller keeps
 * appending to the file it has rather than losing the record. */
function rotate(file: string): boolean {
  try {
    renameSync(file, rotatedPath(file));
    liveSizes.delete(file);
    return true;
  } catch {
    return false;
  }
}

/** Append to a transcript log, rotating first when this write would carry it
 * past `maxBytes`.  The cap is checked BEFORE the write, so a generation only
 * exceeds it when a single record does — and then that record is alone in the
 * file, which is the one shape a cap cannot help.  `append` exists for the
 * event bus, which injects its writer to test disk failure; it is otherwise
 * `appendFileSync`. */
export function appendBounded(
  file: string,
  data: string,
  maxBytes: number,
  options: { mode?: number } = {},
  append: typeof appendFileSync = appendFileSync,
): void {
  const bytes = Buffer.byteLength(data);
  let size = currentSize(file);
  if (size > 0 && size + bytes > maxBytes && rotate(file)) size = 0;
  append(file, data, options);
  rememberSize(file, size + bytes);
}

/** The one call that touches disk in `appendBoundedAsync`, named so the seam
 * the event bus injects is one concrete signature rather than an overloaded
 * builtin.  `fs.promises.appendFile` satisfies it, and so does a synchronous
 * stub in a test that wants the write to fail. */
export type AppendWriter = (file: string, data: string, options: { mode?: number }) => void | Promise<void>;

async function currentSizeAsync(file: string): Promise<number> {
  const cached = liveSizes.get(file);
  if (cached !== undefined) return cached;
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

async function rotateAsync(file: string): Promise<boolean> {
  try {
    await renameFile(file, rotatedPath(file));
    liveSizes.delete(file);
    return true;
  } catch {
    return false;
  }
}

/** `appendBounded` with nothing synchronous left in it — same cap, same
 * rotation, same size cache, off the caller's stack.
 *
 * The event bus publishes on the harness's only thread and the log it feeds
 * carries whole file contents a tool read, so a multi-megabyte append used to
 * stall every other bot's turn, the SSE fan-out and `/api/health` alike.
 *
 * Ordering is the caller's job: this must be driven by ONE in-flight write at
 * a time (`server/harness/append-queue.ts`), because the size bookkeeping and
 * the rotation decision are a read-modify-write over shared state and two
 * concurrent appends to one file would interleave them. */
export async function appendBoundedAsync(
  file: string,
  data: string,
  maxBytes: number,
  options: { mode?: number } = {},
  append: AppendWriter = appendFile,
): Promise<void> {
  const bytes = Buffer.byteLength(data);
  let size = await currentSizeAsync(file);
  if (size > 0 && size + bytes > maxBytes && (await rotateAsync(file))) size = 0;
  await append(file, data, options);
  rememberSize(file, size + bytes);
}

/** Offset of the first byte after the first newline at or after `from`, or
 * null when there is none — meaning no whole line can be kept. */
function firstLineStart(fd: number, from: number, size: number, read: ReadAt): number | null {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK);
  let offset = from;
  while (offset < size) {
    const scanned = read(fd, buffer, 0, Math.min(COPY_CHUNK, size - offset), offset);
    if (scanned <= 0) return null;
    const index = buffer.subarray(0, scanned).indexOf(0x0a);
    if (index !== -1) return offset + index + 1;
    offset += scanned;
  }
  return null;
}

/** Cut an oversized log down to its newest whole lines within `maxBytes`, and
 * return the bytes reclaimed (0 when there was nothing to do).
 *
 * Never reads the file into memory — a 1.9 GB log is seeked past, not loaded —
 * and never leaves a half-written file behind: the kept tail is copied to a
 * sibling temp file, fsynced, and renamed over the original, so a reader sees
 * either the whole old file or the whole new one.  A file whose last record is
 * itself larger than the cap is left exactly as it is: there is no line
 * boundary to cut on, and emptying it would throw away the only record it
 * has.  Idempotent — a file already within the cap is opened, stat'd and left
 * alone.
 *
 * `read` is the same seam `appendBounded` has for its writer: it is
 * `readSync` in production, and a counting wrapper in the test that asserts
 * the bytes leaving the disk are bounded by the cap rather than by the size
 * of the file. */
export function trimToTail(file: string, maxBytes: number, read: ReadAt = readSync): number {
  let fd: number | null = null;
  let tmp: string | null = null;
  let out: number | null = null;
  try {
    try {
      fd = openSync(file, "r");
    } catch {
      return 0;
    }
    const stat = fstatSync(fd);
    if (stat.size <= maxBytes) return 0;
    const start = firstLineStart(fd, stat.size - maxBytes, stat.size, read);
    if (start === null || start >= stat.size) return 0;
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    out = openSync(tmp, "w", 0o600);
    const buffer = Buffer.allocUnsafe(COPY_CHUNK);
    let offset = start;
    while (offset < stat.size) {
      const copied = read(fd, buffer, 0, Math.min(COPY_CHUNK, stat.size - offset), offset);
      if (copied <= 0) break;
      writeFileSync(out, buffer.subarray(0, copied));
      offset += copied;
    }
    fsyncSync(out);
    closeSync(out);
    out = null;
    // Both handles are released before the rename: Windows refuses to replace
    // a file something still holds open, and the read handle is ours.
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    tmp = null;
    // The cached size belongs to the file that was just replaced; the next
    // append re-reads it from disk rather than counting from a stale number.
    liveSizes.delete(file);
    return start;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (out !== null) {
      try {
        closeSync(out);
      } catch {
        /* best-effort cleanup */
      }
    }
    if (tmp !== null) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export interface SweepResult {
  scanned: number;
  trimmed: number;
  bytesReclaimed: number;
  /** stale temp files from a trim that was killed mid-copy */
  tempRemoved: number;
  failed: number;
}

const isTranscriptLogName = (name: string) => name.endsWith(".ndjson") || name.endsWith(`.ndjson${ROTATED_SUFFIX}`);

/** Apply the cap to every log already in `dir`.  This is what trims the files
 * an older build left behind; from then on rotation keeps them bounded and
 * the sweep finds nothing to do.
 *
 * A log this process is already appending to is skipped: rotation bounds it,
 * and trimming under the writer would drop whatever landed between the copy
 * and the rename.  At startup nothing is being appended to yet, which is when
 * the sweep that matters runs. */
export function sweepTranscriptLogs(dir: string, maxBytes: number, now: number = Date.now()): SweepResult {
  const result: SweepResult = { scanned: 0, trimmed: 0, bytesReclaimed: 0, tempRemoved: 0, failed: 0 };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    const temp = TEMP_NAME.exec(name);
    if (temp) {
      const reaped = reapStaleTemp(join(dir, name), Number(temp[2]), now);
      if (reaped.removed) {
        result.tempRemoved += 1;
        result.bytesReclaimed += reaped.bytes;
      }
      continue;
    }
    if (!isTranscriptLogName(name)) continue;
    const file = join(dir, name);
    if (liveSizes.has(file)) continue;
    result.scanned += 1;
    try {
      const reclaimed = trimToTail(file, maxBytes);
      if (reclaimed > 0) {
        result.trimmed += 1;
        result.bytesReclaimed += reclaimed;
      }
    } catch {
      // A log that cannot be trimmed is a log that stays large — never a boot
      // that fails.  Counted so the boot line can say so.
      result.failed += 1;
    }
  }
  return result;
}

interface ReapedTemp {
  removed: boolean;
  /** what it was holding, counted as reclaimed disk like a trim's bytes */
  bytes: number;
}

/** Remove one temp file when the trim that wrote it cannot still be running.
 * A live harness cannot meet its own temp file here — a trim is synchronous
 * and the ownership fence keeps a second harness off this directory — but the
 * rule is "its writer is gone, or it is older than an hour" rather than "any
 * temp file I find", so a future concurrent writer is not robbed mid-copy. */
function reapStaleTemp(file: string, pid: number, now: number): ReapedTemp {
  try {
    const stat = statSync(file);
    if (isProcessAlive(pid) && now - stat.mtimeMs < STALE_TEMP_MS) return { removed: false, bytes: 0 };
    unlinkSync(file);
    // An empty temp file is still a file removed, so the count and the bytes
    // are reported separately rather than inferred from each other.
    return { removed: true, bytes: stat.size };
  } catch {
    return { removed: false, bytes: 0 };
  }
}

export interface TranscriptDirs {
  eventsDir: string;
  nativeDir: string;
  /** The tool input/output side store.  Optional so a caller that predates it
   * (and every test that builds the pair by hand) keeps working. */
  ioDir?: string;
}

/** Every directory a thread's transcript logs live in. */
function transcriptDirList(dirs: TranscriptDirs): string[] {
  return dirs.ioDir ? [dirs.eventsDir, dirs.nativeDir, dirs.ioDir] : [dirs.eventsDir, dirs.nativeDir];
}

/** Every directory at its own cap, summed. */
export function sweepTranscriptRetention(dirs: TranscriptDirs): SweepResult {
  const parts = [
    sweepTranscriptLogs(dirs.eventsDir, EVENTS_LOG_MAX_BYTES),
    sweepTranscriptLogs(dirs.nativeDir, NATIVE_LOG_MAX_BYTES),
    ...(dirs.ioDir ? [sweepTranscriptLogs(dirs.ioDir, ITEM_IO_LOG_MAX_BYTES)] : []),
  ];
  return {
    scanned: parts.reduce((sum, part) => sum + part.scanned, 0),
    trimmed: parts.reduce((sum, part) => sum + part.trimmed, 0),
    bytesReclaimed: parts.reduce((sum, part) => sum + part.bytesReclaimed, 0),
    tempRemoved: parts.reduce((sum, part) => sum + part.tempRemoved, 0),
    failed: parts.reduce((sum, part) => sum + part.failed, 0),
  };
}

/** One line for the boot log, or null when there was nothing to say. */
export function describeSweep(result: SweepResult): string | null {
  if (result.trimmed === 0 && result.failed === 0 && result.tempRemoved === 0) return null;
  const reclaimed = `${(result.bytesReclaimed / (1024 * 1024)).toFixed(1)} MB`;
  const temps = `${result.tempRemoved} stale temp ${result.tempRemoved === 1 ? "file" : "files"} from an interrupted trim`;
  const sentences: string[] = [];
  // Lead with what actually happened: a sweep that only reaped leftovers must
  // not open by announcing that it trimmed nothing.
  if (result.trimmed > 0) {
    sentences.push(`Trimmed ${result.trimmed} of ${result.scanned} thread logs to their size cap, reclaiming ${reclaimed}.`);
    if (result.tempRemoved > 0) sentences.push(`Removed ${temps}.`);
  } else if (result.tempRemoved > 0) {
    sentences.push(`Removed ${temps}, reclaiming ${reclaimed}.`);
  }
  if (result.failed > 0) {
    sentences.push(`${result.failed} ${result.failed === 1 ? "log" : "logs"} could not be trimmed.`);
  }
  return `[transcripts] ${sentences.join("  ")}`;
}

/** Re-run the sweep once a day, for a harness that stays up long enough to
 * outlive the boot one.  Unref'd: it must never be the reason the process
 * stays alive.  Returns the stopper. */
export function startTranscriptRetentionSweeps(
  dirs: TranscriptDirs,
  log: (line: string) => void = console.log,
): () => void {
  const timer = setInterval(() => {
    const line = describeSweep(sweepTranscriptRetention(dirs));
    if (line) log(line);
  }, DAILY_SWEEP_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ── Orphan and age sweep ───────────────────────────────────────────────────
//
// Everything above bounds a LIVE thread's log to a byte cap. Nothing above
// ever asks whether the thread is still live at all, which is the actual gap
// behind HS1: a thread that stops being used keeps its two 64 MB native
// generations and two 16 MB events generations forever — 160 MB per thread
// ever created, observed as 1.2 GB across 209 native files (188 idle 7+
// days) and 143 MB across 202 events files (179 idle 14+ days) on the
// owner's Mac.
//
// The rule is an AND, not an OR: a thread id absent from the store AND whose
// newest file (across both directories, both generations) has not been
// touched in ORPHAN_MAX_AGE_MS. Age alone would delete a long-idle thread the
// user might reopen tomorrow; orphan alone would delete a thread mid-turn if
// the store read raced a save. Together, a false positive needs the store to
// have forgotten the thread AND a week of silence — the same conservatism
// `removeTranscriptLogs`'s callers already rely on for explicit deletes.
//
// Threads that are still in the store are not this sweep's business.  A live
// thread that has simply gone quiet is the idle-live tier further down: it
// keeps the conversation and is trimmed to the newest tail the Inspector
// reads.  There is no archived or completed thread record to hang a third
// tier on.  Snooze is not archive.  Deleting a bot, room, or task is what
// drops an id out of `liveThreadIds`, and this sweep is what removes it.

/** How long an orphaned thread's logs survive before this sweep removes
 * them.  A week, not a day: the daily cap sweep already bounds live disk use,
 * so this only needs to be shorter than "forever". */
export const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a thread that is still in the store keeps its full caps after
 * the last write.  Two weeks, longer than the orphan window on purpose: the
 * conversation is still there, and trimming it is a smaller action than
 * deleting an id the store has already forgotten. */
export const IDLE_LIVE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Newest bytes kept for an idle live thread.  The Inspector never reads
 * more than this (`MAX_TAIL_BYTES` in server/thread-events.ts), so the tail
 * it asks for still fits after the trim. */
export const IDLE_NATIVE_TAIL_BYTES = 8 * 1024 * 1024;
export const IDLE_EVENTS_TAIL_BYTES = 8 * 1024 * 1024;

/** Newest tool input/output kept for an idle live thread.  Older steps
 * already answer "not recorded" once they rotate out; a quiet thread does
 * not need both full generations. */
export const IDLE_IO_TAIL_BYTES = 1 * 1024 * 1024;

/** The rules the acceptance names.  Archived and completed are defined
 * because the finding names them.  This store has no such thread record. */
export const TRANSCRIPT_RETENTION_RULES = {
  "in-flight":
    "A thread with an open turn, a log this process is still appending, or a trim whose writer is still alive is never trimmed or deleted.",
  active:
    "A live thread touched within 14 days keeps the full per-file caps: 64 MB native, 16 MB events, 6 MB item-io, plus one rotated generation.",
  "idle-live":
    "A live thread quiet for 14 days is trimmed to the newest tail the Inspector reads (8 MB native, 8 MB events, 1 MB item-io) on each generation.  The conversation in messages.db stays.",
  archived:
    "No archived-thread record.  A thread that remains on a bot or room follows active or idle-live.  Snooze is not archive.",
  completed:
    "No completed-thread record.  Deleting a bot, room, or task drops the id from the live set.  After 7 days of silence the orphan sweep removes its logs.",
  "orphan-recent":
    "An id missing from the store but written within 7 days is kept, so a store read that raced a save cannot delete a live turn.",
  "orphan-stale":
    "An id missing from the store and quiet for 7 days has every generation and stray trim temp removed.",
} as const;

/** The thread id a transcript log's file name encodes.  Only ever called
 * after `isTranscriptLogName`, so the `.ndjson` / `.ndjson.1` suffix is
 * already known to be there. */
function threadIdFromLogName(name: string): string {
  const base = name.endsWith(ROTATED_SUFFIX) ? name.slice(0, -ROTATED_SUFFIX.length) : name;
  return base.slice(0, -".ndjson".length);
}

/** The thread id a trim's leftover temp file name encodes
 * (`<threadId>.ndjson[.1].<pid>.<uuid>.tmp`), or null when `name` does not
 * match that shape.  `removeTranscriptLogs` already deletes a thread's stray
 * temp files alongside its logs; this is what lets the orphan sweep's own
 * byte/file count agree with what that deletion actually does, rather than
 * silently under-reporting whenever an interrupted trim left one behind. */
function threadIdFromTempName(name: string): string | null {
  const match = TEMP_NAME.exec(name);
  return match ? match[1]! : null;
}

export interface OrphanSweepResult {
  /** distinct orphaned thread ids old enough to act on */
  ids: number;
  /** files removed — or that would be removed under dry run — normally up
   *  to 4 per id (native live/rotated, events live/rotated), plus any stray
   *  `.tmp` file left by an interrupted trim for that id */
  files: number;
  bytesReclaimed: number;
  dryRun: boolean;
}

/** Delete both generations of `native/<id>.ndjson` and `events/<id>.ndjson`,
 * and any leftover trim temp file beside them, for every thread id that is
 * neither in `liveThreadIds` nor touched within `maxAgeMs`.  `liveThreadIds`
 * is the caller's job to build — every bot's
 * active thread and every task thread, every group's active thread and every
 * group task thread (see the call site in index.ts, which builds this the
 * same way `Store`'s own legacy-import pass does).
 *
 * `dryRun` reports exactly what a real run would do — same ids, same file
 * count, same bytes — without touching disk, so `OMB_RETENTION_DRY_RUN=1`
 * gives an honest preview rather than a guess. */
export function sweepOrphanedTranscripts(
  dirs: TranscriptDirs,
  liveThreadIds: ReadonlySet<string>,
  opts: { now?: number; maxAgeMs?: number; dryRun?: boolean } = {},
): OrphanSweepResult {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? ORPHAN_MAX_AGE_MS;
  const dryRun = opts.dryRun ?? false;

  // thread id -> what it holds across BOTH directories, so a write to either
  // one is enough to keep the thread out of the "untouched" bucket.
  const candidates = new Map<string, { files: number; bytes: number; newestMtime: number }>();
  for (const dir of transcriptDirList(dirs)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      let threadId: string;
      if (isTranscriptLogName(name)) {
        threadId = threadIdFromLogName(name);
      } else {
        const tempThreadId = threadIdFromTempName(name);
        if (tempThreadId === null) continue;
        threadId = tempThreadId;
      }
      // Never delete a file for a live id — checked before anything else
      // here touches the file.
      if (liveThreadIds.has(threadId)) continue;
      let stat: { mtimeMs: number; size: number };
      try {
        stat = statSync(join(dir, name));
      } catch {
        continue;
      }
      const entry = candidates.get(threadId) ?? { files: 0, bytes: 0, newestMtime: 0 };
      entry.files += 1;
      entry.bytes += stat.size;
      entry.newestMtime = Math.max(entry.newestMtime, stat.mtimeMs);
      candidates.set(threadId, entry);
    }
  }

  const orphaned: string[] = [];
  let files = 0;
  let bytesReclaimed = 0;
  for (const [threadId, candidate] of candidates) {
    if (now - candidate.newestMtime < maxAgeMs) continue;
    orphaned.push(threadId);
    files += candidate.files;
    bytesReclaimed += candidate.bytes;
  }
  if (!dryRun && orphaned.length) {
    // One listing per directory for every orphan together, the same
    // batching `removeTranscriptLogs` already does for a room's tasks.
    for (const dir of transcriptDirList(dirs)) removeTranscriptLogs(dir, orphaned);
  }
  return { ids: orphaned.length, files, bytesReclaimed, dryRun };
}

/** One line for the boot or daily log, or null when there was nothing to
 * report. */
export function describeOrphanSweep(result: OrphanSweepResult): string | null {
  if (result.files === 0) return null;
  const verb = result.dryRun ? "would remove" : "removed";
  const logs = result.files === 1 ? "log" : "logs";
  return `[retention] ${verb} ${result.files} transcript ${logs}, ${result.bytesReclaimed} bytes`;
}

/** Runs the orphan-and-age sweep once shortly after boot (default 60 s, off
 * the request path so a large `native/`/`events/` directory never delays
 * `server.listen`) and then on the same daily cadence as the cap sweep.
 * `getLiveThreadIds` is called fresh on every run, not just once at
 * registration, so a thread created or deleted after boot is still read
 * correctly a day later.  Both timers are unref'd.  `opts.hold` returns a reason to skip a run (or
 * null to go ahead).  Returns the stopper. */
export function startOrphanTranscriptSweeps(
  dirs: TranscriptDirs,
  getLiveThreadIds: () => Iterable<string>,
  log: (line: string) => void = console.log,
  opts: { dryRun?: boolean; initialDelayMs?: number; hold?: () => string | null } = {},
): () => void {
  const dryRun = opts.dryRun ?? false;
  // The sweep is asked to run daily, but the hold reason only changes when a
  // set-aside file appears or is cleared — logging it on every run would spam
  // the log for as long as the reason stays truthy, so it is logged on change.
  let lastHold: string | null = null;
  const run = () => {
    // `hold` is asked on every run.  A reason means the roster cannot be trusted to say which threads
    // still exist (a set-aside bots.json is waiting), so nothing is treated as an orphan.
    const held = opts.hold?.();
    if (held) {
      if (held !== lastHold) log(`[retention] orphan transcript sweep skipped: ${held}.`);
      lastHold = held;
      return;
    }
    lastHold = null;
    const result = sweepOrphanedTranscripts(dirs, new Set(getLiveThreadIds()), { dryRun });
    const line = describeOrphanSweep(result);
    if (line) log(line);
  };
  const initial = setTimeout(run, opts.initialDelayMs ?? 60_000);
  initial.unref?.();
  const timer = setInterval(run, DAILY_SWEEP_MS);
  timer.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}

// ── Idle-live trim ─────────────────────────────────────────────────────────
//
// The orphan sweep never touches an id that is still in the store, so a
// thread somebody stopped using keeps both generations at the full cap
// forever (audit C10).  This tier trims that thread down to the newest tail
// a reader actually asks for.  It does not delete the thread, its messages,
// or a log a turn is still writing.

export const RETENTION_REASONS = ["in-flight", "active", "idle-live", "orphan-recent", "orphan-stale"] as const;
export type RetentionReason = (typeof RETENTION_REASONS)[number];

export interface RetentionInventoryRow {
  threadId: string;
  /** Milliseconds since the newest live or rotated log was written. */
  ageMs: number;
  /** Bytes on disk for this id, logs and temps together. */
  bytes: number;
  files: number;
  reason: RetentionReason;
}

export interface IdleTailBytes {
  native: number;
  events: number;
  io: number;
}

export interface IdleSweepResult {
  /** Idle live threads that had at least one log over the tail, or a stale temp. */
  ids: number;
  /** Logs trimmed, or that a dry run would trim, plus stale temps removed. */
  files: number;
  /** Bytes a real run actually gave back.  Zero on a dry run: the inventory
   *  rows carry the on-disk totals, and a guess is not a reclaim. */
  bytesReclaimed: number;
  failed: number;
  dryRun: boolean;
  inventory: RetentionInventoryRow[];
}

interface ScannedLog {
  path: string;
  dir: string;
  size: number;
  mtimeMs: number;
}

interface ScannedTemp {
  path: string;
  size: number;
}

interface ScannedThread {
  threadId: string;
  logs: ScannedLog[];
  staleTemps: ScannedTemp[];
  bytes: number;
  files: number;
  newestMtime: number;
  appending: boolean;
  liveWriter: boolean;
}

function defaultIdleTails(): IdleTailBytes {
  return { native: IDLE_NATIVE_TAIL_BYTES, events: IDLE_EVENTS_TAIL_BYTES, io: IDLE_IO_TAIL_BYTES };
}

function tailCap(dir: string, dirs: TranscriptDirs, tails: IdleTailBytes): number {
  if (dir === dirs.nativeDir) return tails.native;
  if (dir === dirs.eventsDir) return tails.events;
  return tails.io;
}

function scanTranscriptThreads(dirs: TranscriptDirs, now: number): ScannedThread[] {
  const byId = new Map<string, ScannedThread>();
  const ensure = (threadId: string): ScannedThread => {
    const existing = byId.get(threadId);
    if (existing) return existing;
    const created: ScannedThread = {
      threadId,
      logs: [],
      staleTemps: [],
      bytes: 0,
      files: 0,
      newestMtime: 0,
      appending: false,
      liveWriter: false,
    };
    byId.set(threadId, created);
    return created;
  };
  for (const dir of transcriptDirList(dirs)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const temp = TEMP_NAME.exec(name);
      if (temp) {
        const threadId = temp[1];
        if (!threadId) continue;
        const path = join(dir, name);
        let stat: { mtimeMs: number; size: number };
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        const row = ensure(threadId);
        row.bytes += stat.size;
        row.files += 1;
        const pid = Number(temp[2]);
        if (isProcessAlive(pid) && now - stat.mtimeMs < STALE_TEMP_MS) row.liveWriter = true;
        else row.staleTemps.push({ path, size: stat.size });
        continue;
      }
      if (!isTranscriptLogName(name)) continue;
      const path = join(dir, name);
      let stat: { mtimeMs: number; size: number };
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      const row = ensure(threadIdFromLogName(name));
      row.logs.push({ path, dir, size: stat.size, mtimeMs: stat.mtimeMs });
      row.bytes += stat.size;
      row.files += 1;
      row.newestMtime = Math.max(row.newestMtime, stat.mtimeMs);
      if (liveSizes.has(path)) row.appending = true;
    }
  }
  return [...byId.values()].sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
}

function retentionReason(
  thread: ScannedThread,
  liveThreadIds: ReadonlySet<string>,
  inFlightThreadIds: ReadonlySet<string>,
  now: number,
  orphanMaxAgeMs: number,
  idleMaxAgeMs: number,
): RetentionReason {
  if (thread.appending || thread.liveWriter || inFlightThreadIds.has(thread.threadId)) return "in-flight";
  const ageMs = thread.logs.length === 0 ? 0 : now - thread.newestMtime;
  if (!liveThreadIds.has(thread.threadId)) return ageMs < orphanMaxAgeMs ? "orphan-recent" : "orphan-stale";
  return ageMs < idleMaxAgeMs ? "active" : "idle-live";
}

export interface RetentionInventoryOptions {
  now?: number;
  orphanMaxAgeMs?: number;
  idleMaxAgeMs?: number;
  inFlightThreadIds?: ReadonlySet<string>;
}

/** One row per thread id that has a log or a temp on disk.  Read-only.
 * Dry-run preview for the orphan delete and the idle trim together. */
export function inventoryTranscriptRetention(
  dirs: TranscriptDirs,
  liveThreadIds: ReadonlySet<string>,
  opts: RetentionInventoryOptions = {},
): RetentionInventoryRow[] {
  const now = opts.now ?? Date.now();
  const orphanMaxAgeMs = opts.orphanMaxAgeMs ?? ORPHAN_MAX_AGE_MS;
  const idleMaxAgeMs = opts.idleMaxAgeMs ?? IDLE_LIVE_MAX_AGE_MS;
  const inFlight = opts.inFlightThreadIds ?? new Set<string>();
  const rows: RetentionInventoryRow[] = [];
  for (const thread of scanTranscriptThreads(dirs, now)) {
    if (thread.files === 0) continue;
    const reason = retentionReason(thread, liveThreadIds, inFlight, now, orphanMaxAgeMs, idleMaxAgeMs);
    rows.push({
      threadId: thread.threadId,
      ageMs: thread.logs.length === 0 ? 0 : now - thread.newestMtime,
      bytes: thread.bytes,
      files: thread.files,
      reason,
    });
  }
  return rows;
}

export interface IdleSweepOptions extends RetentionInventoryOptions {
  dryRun?: boolean;
  tailBytes?: IdleTailBytes;
  read?: ReadAt;
}

/** Trim idle live logs down to the reader tail.  In-flight, active, and
 * orphan ids are classified and left alone.  Orphans belong to
 * `sweepOrphanedTranscripts`.  A dry run fills `inventory` and does not
 * touch disk.  `bytesReclaimed` stays zero until a real run. */
export function sweepIdleLiveTranscripts(
  dirs: TranscriptDirs,
  liveThreadIds: ReadonlySet<string>,
  inFlightThreadIds: ReadonlySet<string> = new Set(),
  opts: IdleSweepOptions = {},
): IdleSweepResult {
  const now = opts.now ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const tails = opts.tailBytes ?? defaultIdleTails();
  const read = opts.read ?? readSync;
  const scanned = scanTranscriptThreads(dirs, now);
  const orphanMaxAgeMs = opts.orphanMaxAgeMs ?? ORPHAN_MAX_AGE_MS;
  const idleMaxAgeMs = opts.idleMaxAgeMs ?? IDLE_LIVE_MAX_AGE_MS;
  const inventory = inventoryFromScan(scanned, liveThreadIds, inFlightThreadIds, now, orphanMaxAgeMs, idleMaxAgeMs);
  const result: IdleSweepResult = {
    ids: 0,
    files: 0,
    bytesReclaimed: 0,
    failed: 0,
    dryRun,
    inventory,
  };
  for (const thread of scanned) {
    const reason = retentionReason(thread, liveThreadIds, inFlightThreadIds, now, orphanMaxAgeMs, idleMaxAgeMs);
    switch (reason) {
      case "idle-live":
        break;
      case "in-flight":
      case "active":
      case "orphan-recent":
      case "orphan-stale":
        continue;
      default: {
        const unexpected: never = reason;
        return unexpected;
      }
    }
    const outcome = reclaimIdleThread(thread, dirs, tails, dryRun, read);
    if (outcome.files === 0 && outcome.failed === 0) continue;
    result.ids += 1;
    result.files += outcome.files;
    result.failed += outcome.failed;
    if (!dryRun) result.bytesReclaimed += outcome.bytesReclaimed;
  }
  return result;
}

function inventoryFromScan(
  scanned: readonly ScannedThread[],
  liveThreadIds: ReadonlySet<string>,
  inFlightThreadIds: ReadonlySet<string>,
  now: number,
  orphanMaxAgeMs: number,
  idleMaxAgeMs: number,
): RetentionInventoryRow[] {
  const rows: RetentionInventoryRow[] = [];
  for (const thread of scanned) {
    if (thread.files === 0) continue;
    rows.push({
      threadId: thread.threadId,
      ageMs: thread.logs.length === 0 ? 0 : now - thread.newestMtime,
      bytes: thread.bytes,
      files: thread.files,
      reason: retentionReason(thread, liveThreadIds, inFlightThreadIds, now, orphanMaxAgeMs, idleMaxAgeMs),
    });
  }
  return rows;
}

interface IdleReclaim {
  files: number;
  bytesReclaimed: number;
  failed: number;
}

function reclaimIdleThread(
  thread: ScannedThread,
  dirs: TranscriptDirs,
  tails: IdleTailBytes,
  dryRun: boolean,
  read: ReadAt,
): IdleReclaim {
  let files = 0;
  let bytesReclaimed = 0;
  let failed = 0;
  for (const log of thread.logs) {
    const cap = tailCap(log.dir, dirs, tails);
    if (log.size <= cap) continue;
    if (dryRun) {
      files += 1;
      continue;
    }
    try {
      const reclaimed = trimToTail(log.path, cap, read);
      if (reclaimed > 0) {
        files += 1;
        bytesReclaimed += reclaimed;
      }
    } catch {
      failed += 1;
    }
  }
  for (const temp of thread.staleTemps) {
    if (dryRun) {
      files += 1;
      continue;
    }
    try {
      unlinkSync(temp.path);
      files += 1;
      bytesReclaimed += temp.size;
    } catch {
      failed += 1;
    }
  }
  return { files, bytesReclaimed, failed };
}

/** Actionable rows of a dry-run inventory: id, age, bytes, and the reason.
 * Active and in-flight threads are left out.  They are excluded from the
 * sweep, and a daily log of every live thread would bury the ones that matter. */
export function formatRetentionInventory(rows: readonly RetentionInventoryRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    switch (row.reason) {
      case "idle-live":
      case "orphan-recent":
      case "orphan-stale":
        lines.push(
          `[retention] ${row.reason} ${row.threadId}, age ${row.ageMs} ms, ${row.bytes} bytes, ${row.files} ${row.files === 1 ? "file" : "files"}`,
        );
        break;
      case "in-flight":
      case "active":
        break;
      default: {
        const unexpected: never = row.reason;
        return unexpected;
      }
    }
  }
  return lines;
}

/** One line for the boot or daily log, or null when there was nothing to
 * say.  A dry run says what it would trim and does not quote a byte count.
 * A real run names only bytes the trim and the temp reap actually gave back. */
export function describeIdleSweep(result: IdleSweepResult): string | null {
  if (result.files === 0 && result.failed === 0) return null;
  const sentences: string[] = [];
  if (result.files > 0) {
    const logs = result.files === 1 ? "log" : "logs";
    sentences.push(
      result.dryRun
        ? `Would trim ${result.files} idle transcript ${logs}.`
        : `Trimmed ${result.files} idle transcript ${logs}, reclaiming ${result.bytesReclaimed} bytes.`,
    );
  }
  if (result.failed > 0) {
    sentences.push(`${result.failed} idle ${result.failed === 1 ? "log" : "logs"} could not be trimmed.`);
  }
  return `[retention] ${sentences.join("  ")}`;
}

/** Runs the idle-live trim once shortly after boot and then daily, on the
 * same hold and dry-run flag as the orphan sweep.  Both timers are unref'd. */
export function startIdleLiveTranscriptSweeps(
  dirs: TranscriptDirs,
  getLiveThreadIds: () => Iterable<string>,
  getInFlightThreadIds: () => Iterable<string> = () => [],
  log: (line: string) => void = console.log,
  opts: { dryRun?: boolean; initialDelayMs?: number; hold?: () => string | null; tailBytes?: IdleTailBytes } = {},
): () => void {
  const dryRun = opts.dryRun ?? false;
  let lastHold: string | null = null;
  const run = () => {
    const held = opts.hold?.();
    if (held) {
      if (held !== lastHold) log(`[retention] idle transcript sweep skipped: ${held}.`);
      lastHold = held;
      return;
    }
    lastHold = null;
    const result = sweepIdleLiveTranscripts(dirs, new Set(getLiveThreadIds()), new Set(getInFlightThreadIds()), {
      dryRun,
      tailBytes: opts.tailBytes,
    });
    if (dryRun) {
      for (const row of formatRetentionInventory(result.inventory)) log(row);
    }
    const line = describeIdleSweep(result);
    if (line) log(line);
  };
  const initial = setTimeout(run, opts.initialDelayMs ?? 60_000);
  initial.unref?.();
  const timer = setInterval(run, DAILY_SWEEP_MS);
  timer.unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
