// Where a supervised sidecar publishes the identity the desktop app adopts.
//
// The sidecar used to be an Electron utilityProcess, so Electron knew its pid
// and its private origin socket because it had just created both.  A
// launchd-supervised sidecar outlives the app, so that knowledge has to cross a
// process boundary and this file is the boundary.
//
// It carries no secret: a pid, a socket path and three port numbers.  It is not
// a capability.  Everything here is a *claim* to be verified, never a fact to
// be trusted, and every consumer must still prove ownership the expensive way —
// see `companionOriginHealth` — before acting on it.  Writing it 0600 inside a
// private directory keeps it from being another user's problem, not because its
// contents are sensitive.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validCompanionOriginTarget } from "./companion-origin-gateway.mjs";

export const MANAGED_COMPANION_RUNTIME_VERSION = 1;
const RUNTIME_DIRECTORY = "runtime";
const RUNTIME_FILE = "supervisor.json";

/** The sidecar's own home, which the sidecar, the supervisor and the app all
 * already agree on without Electron's `app.getPath`. */
export function managedCompanionRuntimeDirectory(home = os.homedir()) {
  return path.join(String(home ?? ""), ".botfleet-companion", RUNTIME_DIRECTORY);
}

export function managedCompanionRuntimePath(home = os.homedir()) {
  return path.join(managedCompanionRuntimeDirectory(home), RUNTIME_FILE);
}

const isPort = (value) => Number.isInteger(value) && value > 0 && value < 65_536;

/** Shape and ownership gate for a runtime file, shared by the writer and both
 * readers.  Returns a frozen copy of the accepted fields, or null.
 *
 * The socket path is validated with the *same* predicate the gateway uses for a
 * live target, so a hand-edited file cannot point the guardian at an arbitrary
 * filesystem path or a TCP port. */
export function validManagedCompanionRuntime(value) {
  if (!value || typeof value !== "object") return null;
  if (value.version !== MANAGED_COMPANION_RUNTIME_VERSION) return null;
  if (!Number.isSafeInteger(value.supervisorPid) || value.supervisorPid <= 0) return null;
  if (!Number.isSafeInteger(value.sidecarPid) || value.sidecarPid <= 0) return null;
  if (!validCompanionOriginTarget({ pid: value.sidecarPid, socketPath: value.socketPath })) {
    return null;
  }
  if (!isPort(value.companionPort) || !isPort(value.controlPort)) return null;
  return Object.freeze({
    version: value.version,
    supervisorPid: value.supervisorPid,
    sidecarPid: value.sidecarPid,
    socketPath: value.socketPath,
    companionPort: value.companionPort,
    controlPort: value.controlPort,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
  });
}

const currentUid = () => {
  if (process.platform === "win32") return undefined;
  return process.getuid?.() ?? os.userInfo().uid;
};

function ensurePrivateDirectory(directory, fileSystem, uid) {
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fileSystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The managed companion runtime path is unsafe");
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error("The managed companion runtime path has an unexpected owner");
  }
  fileSystem.chmodSync(directory, 0o700);
}

/** Publish the supervised sidecar's identity. Written temp-and-rename so a
 * reader never sees a half-written file and adopts a truncated pid. */
export function writeManagedCompanionRuntime(
  state,
  {
    home = os.homedir(),
    fileSystem = fs,
    uid = currentUid(),
    identifier = () => `${process.pid}`,
  } = {},
) {
  const validated = validManagedCompanionRuntime(state);
  if (!validated) throw new Error("The managed companion runtime state is invalid");
  const directory = managedCompanionRuntimeDirectory(home);
  ensurePrivateDirectory(directory, fileSystem, uid);
  const target = managedCompanionRuntimePath(home);
  const temporary = `${target}.${identifier()}.tmp`;
  let descriptor;
  try {
    descriptor = fileSystem.openSync(temporary, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, JSON.stringify(validated, null, 2), "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.chmodSync(temporary, 0o600);
    fileSystem.renameSync(temporary, target);
    return validated;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {}
    }
    try {
      fileSystem.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

/** Read a published claim. Unreadable, foreign-owned, malformed or
 * wrong-version files all read as null: "no supervised sidecar" is the safe
 * answer, because it makes the app fall back to forking one it owns. */
export function readManagedCompanionRuntime(
  { home = os.homedir(), fileSystem = fs, uid = currentUid() } = {},
) {
  const target = managedCompanionRuntimePath(home);
  try {
    const stat = fileSystem.lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (uid !== undefined && stat.uid !== uid) ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    ) {
      return null;
    }
    const raw = fileSystem.readFileSync(target, "utf8");
    if (Buffer.byteLength(raw) > 4096) return null;
    return validManagedCompanionRuntime(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Remove the published claim. Only ever removes the exact regular file this
 * module writes, and only when it still belongs to this user. */
export function clearManagedCompanionRuntime(
  { home = os.homedir(), fileSystem = fs, uid = currentUid() } = {},
) {
  const target = managedCompanionRuntimePath(home);
  try {
    const stat = fileSystem.lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (uid !== undefined && stat.uid !== uid) ||
      path.dirname(target) !== managedCompanionRuntimeDirectory(home)
    ) {
      return false;
    }
    fileSystem.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** A claim whose two pids are both still running.  Still only a claim: the
 * caller proves ownership over the socket before trusting the socket path. */
export function liveManagedCompanionRuntime(
  { isProcessAlive = processIsAlive, ...options } = {},
) {
  const state = readManagedCompanionRuntime(options);
  if (!state) return null;
  if (!isProcessAlive(state.supervisorPid)) return null;
  if (!isProcessAlive(state.sidecarPid)) return null;
  return state;
}

/**
 * The one decision that decides whether the app may treat a supervised sidecar
 * as its own: both pids alive, *and* the private origin answering with the
 * companion identity for that exact pid.
 *
 * Liveness alone is not enough and neither is the file's contents. A supervisor
 * that was SIGKILLed leaves a file whose sidecar pid may since have been reused,
 * and a socket path is just a string until something answers on it. So the
 * probe is the gate, and it is the same probe the app used on the sidecar it
 * forked itself — the app never lowers its bar for a sidecar it did not start.
 *
 * Returns the target to hand the guardian, or null. Null is always the safe
 * answer: the caller falls through to forking a sidecar it owns outright.
 */
export async function adoptableCompanionTarget(
  { isProcessAlive = processIsAlive, probeOwnership, ...options } = {},
) {
  const state = liveManagedCompanionRuntime({ isProcessAlive, ...options });
  if (!state) return null;
  const target = { pid: state.sidecarPid, socketPath: state.socketPath };
  // A probe that throws has not proven ownership. Letting the rejection escape
  // would turn a broken health check into either an unhandled rejection or,
  // once a caller adds a catch-all, into an adoption nobody verified — so the
  // refusal is made here where it cannot be forgotten.
  const proven = await Promise.resolve()
    .then(() => probeOwnership(target))
    .then((value) => value === true)
    .catch(() => false);
  if (!proven) return null;
  return Object.freeze({ ...state, target });
}