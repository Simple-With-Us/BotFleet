// The bridge's durable state (BF-2691).
//
// The device registry and the pairing window are the bridge's own state, and
// both have to survive a restart:  a paired phone that forgets its pairing
// after a systemd restart is a phone the owner has to pair again, and a
// revocation that a restart forgets is a revocation that does not exist.
//
// The state file holds digests only.  The device credential itself is never
// written down, so a copied state file cannot be replayed as a credential.
//
// The file is written atomically through a sibling temporary file and a
// rename, so a crash mid-write leaves the previous state rather than a
// half-written one, and it is written owner-only.  A state file that is a
// symlink, that anyone but the owner can read, or that has a second name is
// refused rather than read.

import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The state file's own mode: owner read and write, nobody else. */
export const BRIDGE_STATE_MODE = 0o600;

/**
 * Read the durable state.
 *
 * A missing file is an empty state, not an error:  the bridge has not been
 * used yet.  A file that cannot be trusted is refused, because a state read
 * loosely would be a registry read from an attacker.
 *
 * @param {string} path
 * @returns {{state: {devices?: unknown[], window?: unknown}|null, existed: boolean}}
 */
export function loadBridgeState(path) {
  const target = resolve(path);
  let entry;
  try {
    entry = lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: null, existed: false };
    throw new Error(`the bridge state file could not be read: ${error?.code ?? 'unknown error'}`);
  }
  if (entry.isSymbolicLink()) {
    throw new Error('the bridge state file is a symlink; it must be a regular file');
  }
  if (!entry.isFile()) {
    throw new Error('the bridge state file is not a regular file');
  }
  if (entry.nlink !== 1) {
    throw new Error('the bridge state file has more than one hard link; it must have exactly one');
  }
  if (process.getuid && entry.uid !== process.getuid()) {
    throw new Error('the bridge state file is not owned by the user the bridge runs as');
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new Error(`the bridge state file is readable beyond its owner (mode ${(entry.mode & 0o777).toString(8)})`);
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new Error('the bridge state file changed while it was read');
    }
    const text = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.size !== opened.size) {
      throw new Error('the bridge state file changed while it was read');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('the bridge state file is not valid JSON');
    }
    if (!parsed || Object(parsed) !== parsed || Array.isArray(parsed)) {
      throw new Error('the bridge state file does not hold an object');
    }
    return { state: parsed, existed: true };
  } finally {
    closeSync(fd);
  }
}

/**
 * Write the durable state.
 *
 * The bytes go to a sibling temporary file first and are renamed over the
 * target, so a reader never sees a partial state and a crash mid-write
 * leaves the previous one.  The temporary file is removed if the rename
 * fails.
 *
 * @param {string} path
 * @param {unknown} state
 */
export function saveBridgeState(path, state) {
  const target = resolve(path);
  const directory = dirname(target);
  const temporary = join(directory, `.${Date.now()}.${process.pid}.bridge-state.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, BRIDGE_STATE_MODE);
    writeFileSync(fd, bytes);
    fchmodSync(fd, BRIDGE_STATE_MODE);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(temporary); } catch { /* nothing to remove */ }
    throw new Error(`the bridge state file could not be written: ${error?.code ?? 'unknown error'}`);
  }
}
