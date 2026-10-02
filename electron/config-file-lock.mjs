// One writer at a time for ~/.botfleet/config.json, across processes.
//
// Two OS processes write that file: the harness server (server/config.ts's
// saveConfig) and the packaged Electron main process (the auto-updater's
// recordAutomaticCheck and the boot-time credential migrations in main.mjs).
// A second harness can appear too -- the packaged app forks its own when it
// cannot attach to the always-on one -- and it inherits the same data dir.
// Every one of them does a whole-file read-modify-write.  Temp-file-then-
// rename already makes each write atomic, so a reader sees the old file or
// the new one and never a torn one, but it does nothing for the lost-update
// race: a Settings save that lands between another writer's read and its
// rename is replaced by that writer's stale snapshot and silently reverts.
// (PR #251 review, board a2a3a586.)
//
// This module is the one door every writer goes through.  `updateConfigFile`
// takes an advisory lock, reads the file, hands the parsed object to the
// caller's `mutate`, writes the result atomically, and releases.  The lock is
// a sibling `config.json.lock` created with O_EXCL -- atomic on macOS, Linux
// and Windows -- holding the owner's pid, a timestamp and a random token.
//
// Two rules keep it safe without anything POSIX does not offer:
//
//   1. No process ever removes or replaces another process's live lock.  A
//      lock left behind by a crashed, released-but-stuck, or overrun holder
//      is TAKEN OVER in place, and only by one waiter: taking over generation
//      R means first winning `config.json.lock.takeover.<R>` with O_EXCL,
//      then renaming a file holding the taker's own record over the lock.
//      Only one waiter can win a given generation, and nothing but that
//      winner can replace a stale R (its holder is dead, gave up, or is past
//      its lease and by rule 2 no longer touches it), so the rename never
//      lands on a fresh lock and nothing is ever deleted out from under one.
//   2. A holder acts on its lock -- writes through it, or unlinks it on
//      release -- only inside its usable lease, `staleMs` less a margin.  A
//      peer may take the lock over only once the full `staleMs` is out, so
//      inside the usable lease nothing else can replace the generation and
//      the holder's own by-name unlink still refers to it.  Past the lease
//      the holder leaves the lock alone and its fence refuses the write.
//
// Readers never need the lock: the rename keeps reads consistent on their
// own.  It lives under electron/ rather than shared/ because the packaged app
// ships only electron/** (electron-builder.yml `files`); the server imports
// it from here and its esbuild bundle inlines it.  Dependency-free on
// purpose: the packaged app carries no node_modules, so `proper-lockfile` and
// friends are not an option on the Electron side.  The server's TypeScript
// sees it through config-file-lock.d.mts.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** A lock older than this is taken over even when its owner pid still
 * answers: a healthy read-modify-write holds it for milliseconds, and pids
 * get reused, so an old lock with a live pid is usually a crashed writer
 * whose number came back around.  The other way to get here is a holder
 * suspended mid-update -- system sleep, a debugger pause, a filesystem
 * stall.  That holder is fenced, not trusted: `assertHeld` refuses its
 * write once its usable lease is over, so a takeover can never let two
 * writers land snapshots on one file. */
export const CONFIG_LOCK_STALE_MS = 30_000;

/** How long a writer waits for the lock before giving up with an error.
 * The wait is synchronous (the writers are), so this bounds how long a
 * stuck peer can stall the caller's event loop.  Well above any healthy
 * hold; the caller reports the failure instead of writing a stale
 * snapshot over whatever the holder is doing. */
export const CONFIG_LOCK_TIMEOUT_MS = 5_000;

const MAX_BACKOFF_MS = 50;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Takeover tickets are keyed to the generation they replaced and are never
 * needed again once every waiter that judged that generation stale has
 * moved on -- a judgment lives one acquire loop iteration, bounded by the
 * acquire timeout.  A winner prunes tickets older than this on release. */
const TAKEOVER_TICKET_TTL_MS = 10 * 60 * 1000;

/** Windows reports a lock file that another process has just unlinked, or
 * still holds open for reading, as EPERM or EACCES (delete is deferred until
 * the last handle closes) rather than EEXIST or ENOENT, and an unlink or a
 * rename can fail the same way for a few microseconds.  Those are "try
 * again shortly", not permission problems; a real one persists past the
 * acquire timeout and surfaces there. */
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Handles this process currently holds, by lock path.  Re-entry is judged
 * here, not by the pid on disk: a record carrying this pid but no live
 * handle is a leftover from a release whose unlink was refused, and is taken
 * over like any other stale lock. */
const heldLocks = new Map();

/** The lock file that guards `configPath`. */
export function lockPathFor(configPath) {
  return `${configPath}.lock`;
}

/** Park this thread for `ms` without burning CPU.  Atomics.wait is
 * permitted on the main thread of every runtime this module runs in -- a
 * Node process, and the Electron main process is a Node isolate too.  The
 * writers are synchronous by design (the critical section is a
 * millisecond-scale read-modify-write), so a wait happens only under
 * contention and is capped by the acquire timeout. */
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function isTransient(error) {
  return TRANSIENT_CODES.has(error?.code);
}

/** How much of the lease a holder leaves unused (rule 2 above).
 * Proportional so tests with tiny leases keep a usable window. */
function leaseMarginMs(staleMs) {
  return Math.min(2_000, staleMs / 4);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLockRecord(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    if (isPlainObject(parsed) && Number.isInteger(parsed.pid) && Number.isFinite(parsed.at)) {
      return parsed;
    }
  } catch {
    /* missing, mid-write, or garbage -- handled by the caller */
  }
  return null;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: exists, but not ours to signal.  Only ESRCH means gone.
    return error?.code !== "ESRCH";
  }
}

/** What is at `lockPath` right now -- its parsed record (null when
 * unreadable) plus the file's mtime -- or null when there is no lock. */
function inspectLock(lockPath) {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    return null;
  }
  return { record: readLockRecord(lockPath), ino: stat.ino, mtimeMs: stat.mtimeMs };
}

/** The O_EXCL ticket a waiter must win to take over the exact generation
 * `seen`: its token when the record is readable, else the file's inode and
 * mtime.  Unique per generation, so a ticket can never be re-created for
 * a generation once it has been taken over. */
function takeoverTicketFor(lockPath, seen) {
  const identity = seen.record
    ? (seen.record.token ?? `${seen.record.pid}-${Math.floor(seen.record.at)}`)
    : `${seen.ino}-${Math.floor(seen.mtimeMs)}`;
  return `${lockPath}.takeover.${String(identity).replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Remove takeover tickets beside `lockPath` that are past their TTL.
 * Ticket names are unique per generation, so removing an old one cannot
 * collide with anything a live waiter could still create. */
function pruneTakeoverTickets(lockPath) {
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.takeover.`;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - TAKEOVER_TICKET_TTL_MS;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const ticket = join(dir, name);
    try {
      if (statSync(ticket).mtimeMs < cutoff) unlinkWithRetry(ticket);
    } catch {
      /* gone already */
    }
  }
}

/** True when the inspected lock belongs to nobody who could still release
 * it: its holder marked it released, its lease is fully out, or its pid is
 * dead.  An unreadable file is judged by its mtime. */
function isStaleLock(seen, nowMs, staleMs) {
  if (seen.record) {
    if (seen.record.released === true) return true;
    if (nowMs - seen.record.at > staleMs) return true;
    return !processAlive(seen.record.pid);
  }
  return nowMs - seen.mtimeMs > staleMs;
}

/** Write `record` into `lockPath` by renaming a sibling temp file over it
 * (rule 1 above).  Returns false on a transient refusal so the caller can
 * retry; throws on anything else. */
function replaceLockRecord(lockPath, record) {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, "w", 0o600);
    writeFileSync(fd, JSON.stringify(record));
    closeSync(fd);
    fd = null;
    renameSync(temporary, lockPath);
    return true;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      /* best-effort cleanup */
    }
    if (isTransient(error) || error?.code === "ENOENT") return false;
    throw error;
  }
}

/** unlinkSync with a few short retries for the Windows deferred-delete
 * case.  Returns true when the file is gone (or was never there). */
function unlinkWithRetry(path) {
  let delay = 1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return true;
      if (!isTransient(error)) return false;
      sleepSync(delay);
      delay = Math.min(delay * 2, 20);
    }
  }
  return false;
}

/** Take over the stale generation `seen` (rule 1): win its ticket, then
 * rename our record over the lock.  Returns the handle, or null when another
 * waiter already holds this generation's ticket or the rename was refused
 * transiently (the caller keeps waiting; the lock will be fresh or gone). */
function takeOver(lockPath, seen, ours, staleMs) {
  const ticket = takeoverTicketFor(lockPath, seen);
  let fd = null;
  try {
    fd = openSync(ticket, "wx", 0o600);
    closeSync(fd);
    fd = null;
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
    if (error?.code === "EEXIST" || isTransient(error)) return null;
    throw error;
  }
  let delay = 1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    ours.at = Date.now();
    if (replaceLockRecord(lockPath, ours)) return makeHandle(lockPath, ours, staleMs, true);
    sleepSync(delay);
    delay = Math.min(delay * 2, 20);
  }
  // The rename kept being refused.  Give the ticket back (it is ours and
  // unique, so removing it is safe) and let the caller keep waiting.
  unlinkWithRetry(ticket);
  return null;
}

function makeHandle(lockPath, ours, staleMs, tookOver = false) {
  heldLocks.set(lockPath, ours);
  let released = false;
  const stillOurs = () => {
    const current = readLockRecord(lockPath);
    return Boolean(
      current && current.pid === ours.pid && current.at === ours.at && current.token === ours.token,
    );
  };
  const insideUsableLease = () => Date.now() - ours.at <= staleMs - leaseMarginMs(staleMs);
  return {
    /** Throw unless this handle still owns the lock and its usable lease
     * (`staleMs` less the margin) has not run out.  `updateConfigFile` runs
     * it immediately before the rename that replaces the config file, so a
     * holder that was suspended past the stale window (system sleep, a
     * debugger pause, a filesystem stall) and whose lock a peer has since
     * taken over can never land its stale snapshot on top of the peer's
     * write.  The lease is what makes taking over safe. */
    assertHeld() {
      if (released) throw new Error(`config lock already released: ${lockPath}`);
      if (!insideUsableLease()) {
        throw new Error(
          `config lock lease expired after ${staleMs} ms; refusing to write a stale snapshot: ${lockPath}`,
        );
      }
      if (!stillOurs()) {
        throw new Error(`config lock was taken over by another writer; refusing to write a stale snapshot: ${lockPath}`);
      }
    },
    release() {
      if (released) return;
      released = true;
      heldLocks.delete(lockPath);
      if (tookOver) pruneTakeoverTickets(lockPath);
      // Past the usable lease this handle no longer touches the lock by
      // name: a peer may be taking it over at this very moment.  It is left
      // for that takeover, which judges it stale by age within the margin.
      if (!insideUsableLease()) return;
      if (!stillOurs()) return;
      if (unlinkWithRetry(lockPath)) return;
      // The unlink was refused even after retries (a scanner or a peer holds
      // the file open on Windows).  Mark the record released -- a rename
      // over our own live lock, safe inside the lease -- so peers take it
      // over at once instead of waiting out the lease.  If even that is
      // refused they wait out the lease; this process itself is not wedged
      // either way, since re-entry is judged by live handles, not the pid.
      replaceLockRecord(lockPath, { ...ours, released: true });
    },
  };
}

/** Acquire the advisory lock for `configPath`.  Returns a handle with
 * `release()` and `assertHeld()`.  Synchronous, like the writers that use
 * it: waits with short sleeps until the lock is free, takes over a stale
 * one, and throws after `timeoutMs` so a wedged peer surfaces as an error
 * instead of a silent overwrite.  Re-entering from a handle this process
 * still holds is a bug, not a wait, and throws immediately. */
export function acquireConfigFileLock(configPath, options = {}) {
  const lockPath = lockPathFor(configPath);
  const staleMs = options.staleMs ?? CONFIG_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? CONFIG_LOCK_TIMEOUT_MS;
  if (heldLocks.has(lockPath)) {
    throw new Error(`config lock re-entered by this process: ${lockPath}`);
  }
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let backoffMs = 2;
  let lastTransient = null;
  for (;;) {
    const ours = { pid: process.pid, at: Date.now(), token: randomUUID() };
    let fd = null;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(ours));
      closeSync(fd);
      fd = null;
      return makeHandle(lockPath, ours, staleMs);
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* best-effort */
        }
      }
      if (error?.code !== "EEXIST") {
        if (!isTransient(error)) throw error;
        lastTransient = error;
      }
    }
    const now = Date.now();
    const seen = inspectLock(lockPath);
    if (seen && isStaleLock(seen, now, staleMs)) {
      const handle = takeOver(lockPath, seen, ours, staleMs);
      if (handle) return handle;
    }
    if (!seen && lastTransient === null) continue; // released between our attempt and this look
    if (now - startedAt >= timeoutMs) {
      if (!seen) {
        throw new Error(
          `config lock could not be created (${lastTransient.code}) within ${timeoutMs} ms: ${lockPath}`,
        );
      }
      const who = seen.record ? `pid ${seen.record.pid}` : "an unknown writer";
      throw new Error(`config lock held by ${who} for more than ${timeoutMs} ms: ${lockPath}`);
    }
    sleepSync(backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

/** Run `fn(lock)` while holding the lock for `configPath`. */
export function withConfigFileLock(configPath, fn, options = {}) {
  const lock = acquireConfigFileLock(configPath, options);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}

/** Drop a leading byte-order mark, which some editors add when a person
 * fixes a file by hand.  Mirrors stripBom in server/store-guard.ts. */
function stripBom(text) {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** Why JSON.parse failed, safe to log: only a position, never the text
 * around it, because config.json holds API keys and the parser's own
 * message quotes the source.  Mirrors jsonFailureReason in
 * server/store-guard.ts, which the packaged app cannot import. */
function jsonFailureReason(error, length) {
  const message = String(error?.message ?? "");
  if (/end of JSON input|unterminated/i.test(message)) return "it ends early (it looks cut short)";
  const at = /position (\d+)/.exec(message)?.[1];
  if (at && length !== undefined && Number(at) >= length) return "it ends early (it looks cut short)";
  return at ? `it is not valid JSON (near character ${at})` : "it is not valid JSON";
}

/** Read `configPath` and say whether what is there can be used.
 * `disk` is the parsed object, or `{}` when there is nothing usable.
 * `unusable` is null for a file that is missing, empty or healthy, and
 * otherwise the reason a file that DOES hold something could not be used
 * (not JSON, not an object, unreadable) -- that file is somebody's settings
 * and must not be written over without being kept. */
function inspectConfigFile(configPath) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { disk: {}, unusable: null };
    return { disk: {}, unusable: `it could not be read (${error?.code ?? "unknown error"})` };
  }
  const body = stripBom(text);
  if (body.trim() === "") return { disk: {}, unusable: null };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { disk: {}, unusable: jsonFailureReason(error, body.length) };
  }
  if (!isPlainObject(parsed)) return { disk: {}, unusable: "it does not hold a JSON object" };
  return { disk: parsed, unusable: null };
}

/** The parsed config object on disk, or `{}` when the file is missing or
 * not a JSON object -- the state of a fresh install, not an error.  Every
 * writer treats that the same way, so it lives here once.  A file that holds
 * something unusable also reads as `{}`, but `updateConfigFile` sets it aside
 * before it would be replaced. */
export function readConfigFile(configPath) {
  return inspectConfigFile(configPath).disk;
}

/** Rename an unusable `configPath` to `<name>.corrupt-<epoch ms>` beside it.
 * Never overwrites an existing name and never deletes; the rename keeps the
 * file's private mode.  Returns where it went, or null if another process
 * had already moved it.  Throws if it cannot be moved. */
function setConfigFileAside(configPath, now) {
  let target = `${configPath}.corrupt-${now}`;
  for (let n = 1; existsSync(target); n += 1) target = `${configPath}.corrupt-${now}-${n}`;
  try {
    renameSync(configPath, target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return target;
}

/** Durable, atomic file replace: write a sibling temp file, fsync it, rename
 * it over the target.  Mirrors server/atomic.ts, which the packaged Electron
 * process cannot import (only electron/** ships).
 *
 * `options.beforeRename`, when given, runs after the temp file is staged
 * and fsynced and immediately before the rename; if it throws, the temp
 * file is removed and nothing replaces the target.  The lock fence uses it
 * so the ownership check sits as close to the rename as a check can, with
 * the serialisation, the write and the fsync (which can stall) all behind
 * it rather than between it and the rename. */
export function writeFileAtomic(path, data, options = {}) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, "w", options.mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    options.beforeRename?.();
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

/** The locked read-modify-write every config.json writer must use.
 *
 * Under the lock: read the file (`{}` when absent), call `mutate(disk)`,
 * and write what it returns.  `mutate` may edit `disk` in place and return
 * nothing, return a replacement object, or return `null` to say the file is
 * already right and must not be rewritten.  It must be synchronous: the
 * lock is held for the duration of this call and released on the way out,
 * success or throw.  Returns the object now on disk.  Throws without
 * replacing the file if the lease expired or a peer took the lock over by
 * the time the staged write is about to be renamed into place. */
export function updateConfigFile(configPath, mutate, options = {}) {
  return withConfigFileLock(
    configPath,
    (lock) => {
      const { disk, unusable } = inspectConfigFile(configPath);
      const next = mutate(disk);
      if (next && typeof next.then === "function") {
        throw new TypeError("updateConfigFile: mutate must be synchronous");
      }
      if (next === null) return disk;
      const toWrite = next === undefined ? disk : next;
      // Fence, immediately before the rename: refuse to replace the file if
      // this lease ran out or a peer took the lock over while `mutate`, the
      // temp-file write or the fsync ran.  The staged temp file is dropped,
      // the peer's file stays intact, and the caller sees an error instead.
      //
      // A file that held something unusable is set aside in the same
      // breath, after the fence and just before the rename that replaces
      // it, so the write that follows can never destroy it.  If it cannot be
      // moved, the throw drops the staged file and the original stays put.
      writeFileAtomic(configPath, JSON.stringify(toWrite, null, 2), {
        mode: options.mode ?? 0o600,
        beforeRename: () => {
          lock.assertHeld();
          if (unusable === null) return;
          let setAsidePath;
          try {
            setAsidePath = setConfigFileAside(configPath, options.now ?? Date.now());
          } catch (error) {
            throw new Error(
              `${configPath} could not be used because ${unusable}, and it could not be moved aside (${error?.code ?? "unknown error"}), so it was not overwritten`,
            );
          }
          (options.onSetAside ?? reportSetAside)({ path: configPath, setAsidePath, reason: unusable });
        },
      });
      return toWrite;
    },
    options,
  );
}

function reportSetAside({ path, setAsidePath, reason }) {
  console.warn(
    `config: ${path} could not be used because ${reason}.  ${setAsidePath ? `Moved it to ${setAsidePath}` : "It was already moved aside"} and wrote a new file.  Nothing was deleted.`,
  );
}
