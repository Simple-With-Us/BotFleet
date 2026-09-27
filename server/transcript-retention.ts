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
}

/** Both directories at their own caps, summed. */
export function sweepTranscriptRetention(dirs: TranscriptDirs): SweepResult {
  const events = sweepTranscriptLogs(dirs.eventsDir, EVENTS_LOG_MAX_BYTES);
  const native = sweepTranscriptLogs(dirs.nativeDir, NATIVE_LOG_MAX_BYTES);
  return {
    scanned: events.scanned + native.scanned,
    trimmed: events.trimmed + native.trimmed,
    bytesReclaimed: events.bytesReclaimed + native.bytesReclaimed,
    tempRemoved: events.tempRemoved + native.tempRemoved,
    failed: events.failed + native.failed,
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
// A sibling project (server/thread-retention.ts, PR #1280) sweeps by a
// different axis: threads still IN the store but closed or archived, guarded
// by skipping anything busy, unread, or with an open direct handoff. That
// does not apply here — this codebase's TaskRecord/BotRecord/GroupRecord
// have no closedAt/archivedAt/openDirectHandoff, and there is no close- or
// archive-thread feature to hang that guard on. It would not be redundant
// even if ported: this sweep already only ever considers ids `liveThreadIds`
// does NOT contain, and busy/unread/handoff-open are properties of a record
// that is, by construction, still in that set — so a thread this sweep could
// ever touch has no such state to check in the first place. Porting the
// field-based guard here would be a no-op at best and a schema change this
// finding never asked for at worst.

/** How long an orphaned thread's logs survive before this sweep removes
 * them.  A week, not a day: the daily cap sweep already bounds live disk use,
 * so this only needs to be shorter than "forever". */
export const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  for (const dir of [dirs.eventsDir, dirs.nativeDir]) {
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
    for (const dir of [dirs.eventsDir, dirs.nativeDir]) removeTranscriptLogs(dir, orphaned);
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
 * correctly a day later.  Both timers are unref'd.  Returns the stopper. */
export function startOrphanTranscriptSweeps(
  dirs: TranscriptDirs,
  getLiveThreadIds: () => Iterable<string>,
  log: (line: string) => void = console.log,
  opts: { dryRun?: boolean; initialDelayMs?: number } = {},
): () => void {
  const dryRun = opts.dryRun ?? false;
  const run = () => {
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
