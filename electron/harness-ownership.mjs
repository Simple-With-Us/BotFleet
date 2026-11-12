// A harness owns its data root for its entire process lifetime.  The short
// file lock serializes acquisition only; an unresponsive live owner never
// loses ownership to a lease or health-check timeout.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { withConfigFileLock, writeFileAtomic } from "./config-file-lock.mjs";

function ownerPath(dataDir) {
  return join(realpathSync(dataDir), "harness-owner.json");
}

function readRecord(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let record;
  try { record = JSON.parse(raw); } catch {
    throw new Error("BotFleet data ownership record is invalid; refusing a second harness");
  }
  if (record?.version !== 1 || !Number.isInteger(record.pid) || record.pid <= 0 ||
      !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
      typeof record.nonce !== "string" || !/^[a-f0-9]{64}$/.test(record.nonce)) {
    throw new Error("BotFleet data ownership record is invalid; refusing a second harness");
  }
  return record;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // An inaccessible or reused PID is deliberately fail-closed.  Only a
    // confirmed dead process permits recovery; time and health are not proof.
    return error.code !== "ESRCH";
  }
}

export function readHarnessOwner(dataDir) {
  let file;
  try {
    file = ownerPath(dataDir);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const record = readRecord(file);
  return record && isAlive(record.pid) ? record : null;
}

export function acquireHarnessOwnership(dataDir, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid harness port");
  const file = ownerPath(dataDir);
  return withConfigFileLock(file, (lock) => {
    const previous = readRecord(file);
    if (previous && isAlive(previous.pid)) {
      throw new Error(`BotFleet data is already owned by a live harness (pid ${previous.pid}, port ${previous.port})`);
    }
    const record = { version: 1, pid: process.pid, port, nonce: randomBytes(32).toString("hex") };
    writeFileAtomic(file, JSON.stringify(record), { mode: 0o600, beforeRename: () => lock.assertHeld() });
    // Keep the record through shutdown, including provider disposal.  The OS
    // ending this process is the fence that makes the next acquisition safe.
    return record;
  });
}

export function initializeHarnessOwnership(dataDir, port, prepareDataDir) {
  // A sibling lock exists before the data directory itself, so first-run
  // creation and legacy rename cannot race between updated harness starts.
  return withConfigFileLock(`${resolve(dataDir)}.startup`, () => {
    prepareDataDir();
    return acquireHarnessOwnership(dataDir, port);
  });
}

export function harnessOwnerProof(owner, challenge) {
  if (typeof challenge !== "string" || !/^[a-f0-9]{64}$/.test(challenge)) return undefined;
  return createHmac("sha256", owner.nonce).update(challenge).digest("hex");
}

export function verifyHarnessOwnerProof(owner, challenge, proof) {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = harnessOwnerProof(owner, challenge);
  return expected !== undefined && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(proof, "hex"));
}
