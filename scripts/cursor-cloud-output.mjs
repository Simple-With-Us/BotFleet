import { constants, realpathSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, rename, rm, rmdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "botfleet-cursor-bootstrap";
const NAMES = ["BotFleet.env", "BotFleet.source.sh", "BotFleet.manifest.json"];
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function readRecord(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe output file.");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("Output file is not private and owned.");
    return { content: await file.readFile("utf8"), mode: stat.mode & 0o777, uid: stat.uid, dev: stat.dev, ino: stat.ino };
  } finally { await file.close(); }
}

const sameRecord = (a, b) => a === null || b === null ? a === b :
  a.content === b.content && a.mode === b.mode && a.uid === b.uid && a.dev === b.dev && a.ino === b.ino;

const serial = (record) => record === null ? null : ({ hash: digest(record.content), mode: record.mode, uid: record.uid, dev: record.dev, ino: record.ino });
const matchesSerial = (record, expected) => record === null || expected === null ? record === expected :
  digest(record.content) === expected.hash && record.mode === expected.mode && record.uid === expected.uid &&
  record.dev === expected.dev && record.ino === expected.ino;
const lockMarker = JSON.stringify({ owner: OWNER, version: 1 }) + "\n";

async function acquireOsLock(outputDir, waitMs, operations) {
  const path = join(outputDir, ".BotFleet.lock");
  const temporary = join(outputDir, `.BotFleet.lock-new-${randomUUID()}`);
  const staging = await open(temporary, "wx", 0o600);
  try { await staging.writeFile(lockMarker); await staging.sync(); } finally { await staging.close(); }
  try { await link(temporary, path); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { await rm(temporary); }
  const record = await readRecord(path);
  if (!record || record.content !== lockMarker) throw new Error("Unverified lock file.");
  const file = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  const child = spawn("python3", ["-I", "-S", "-c", "import fcntl,sys; fcntl.flock(3,fcntl.LOCK_EX); print('LOCKED',flush=True); sys.stdin.buffer.read()"], {
    stdio: ["pipe", "pipe", "pipe", file.fd], env: { PATH: process.env.PATH, LANG: "C" },
  });
  let releasing = false;
  let lost = false;
  const markLost = () => {
    if (!releasing) { lost = true; operations.onLockLost?.(); }
  };
  child.once("exit", markLost);
  child.once("error", markLost);
  const assertHeld = () => {
    if (lost || child.exitCode !== null || child.signalCode !== null) throw new Error("Output OS lock was lost.");
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Output lock timed out.")); }, waitMs);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Output lock helper exited.")); });
      child.stdout.once("data", (chunk) => {
        clearTimeout(timer);
        if (chunk.toString() === "LOCKED\n") resolve(); else reject(new Error("Invalid output lock response."));
      });
    });
    await operations.onLockAcquired?.(child.pid);
    assertHeld();
    if (!sameRecord(await readRecord(path), record)) throw new Error("Output lock pathname changed.");
    assertHeld();
    return { assertHeld, release: async () => {
      releasing = true;
      const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve();
      child.stdin.end();
      await exited;
      await file.close();
    } };
  } catch (error) {
    child.kill();
    if (child.pid && child.exitCode === null && child.signalCode === null) await once(child, "exit");
    await file.close();
    throw error;
  }
}

function validateReceipt(records) {
  if (![...records.values()].some((record) => record !== null)) return;
  const text = records.get(NAMES[2])?.content;
  if (!text) throw new Error("Outputs have no ownership manifest.");
  const manifest = JSON.parse(text);
  if (Object.keys(manifest).sort().join(",") !== "files,owner,scopeFingerprint,version" || manifest.owner !== OWNER ||
      manifest.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.scopeFingerprint) ||
      Object.keys(manifest.files).sort().join(",") !== `${NAMES[0]},${NAMES[1]}` ||
      NAMES.slice(0, 2).some((name) => !/^[a-f0-9]{64}$/.test(manifest.files[name]) ||
        (records.get(name) !== null && manifest.files[name] !== digest(records.get(name).content)))) throw new Error("Outputs do not match their ownership receipt.");
}

function validateSerial(record) {
  if (record === null) return;
  if (Object.keys(record).sort().join(",") !== "dev,hash,ino,mode,uid" || !/^[a-f0-9]{64}$/.test(record.hash) ||
      record.mode !== 0o600 || ![record.uid, record.dev, record.ino].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      (process.getuid && record.uid !== process.getuid())) throw new Error("Invalid transaction record.");
}

function parseJournal(record, directory) {
  if (!record) throw new Error("Incomplete transaction preserved.");
  const journal = JSON.parse(record.content);
  if (Object.keys(journal).sort().join(",") !== "directory,initial,intent,owner,pid,staged,version" ||
      journal.owner !== OWNER || journal.version !== 1 || !Number.isSafeInteger(journal.pid) || journal.pid <= 0 ||
      !["pending", "publish", "invalidate"].includes(journal.intent) || journal.directory !== `${directory.dev}:${directory.ino}` ||
      Object.keys(journal.initial).sort().join(",") !== [...NAMES].sort().join(",") ||
      !["", [...NAMES].sort().join(",")].includes(Object.keys(journal.staged).sort().join(","))) throw new Error("Unverified transaction journal.");
  for (const value of [...Object.values(journal.initial), ...Object.values(journal.staged)]) validateSerial(value);
  return journal;
}

function recoveryEntry(name, journal) {
  const canonical = /^(old|new)-(BotFleet\.(?:env|source\.sh|manifest\.json))$/.exec(name);
  const disposal = /^dispose-(old|new)-(BotFleet\.(?:env|source\.sh|manifest\.json))-[0-9a-f-]{36}$/.exec(name);
  const intermediate = /^(invalidate|recover|failed)-(BotFleet\.(?:env|source\.sh|manifest\.json))-[0-9a-f-]{36}$/.exec(name);
  const filename = canonical?.[2] ?? disposal?.[2] ?? intermediate?.[2];
  if (!filename || !NAMES.includes(filename)) throw new Error("Unknown recovery residue preserved.");
  const old = canonical?.[1] === "old" || disposal?.[1] === "old" || intermediate?.[1] === "invalidate";
  if (intermediate?.[1] === "invalidate" && (journal.intent !== "invalidate" || filename === NAMES[2])) throw new Error("Unverified invalidation residue.");
  const expected = old ? journal.initial[filename] : journal.staged[filename];
  if (!expected) throw new Error("Unjournaled residue preserved.");
  return { filename, old, expected };
}

async function recoverTransactions(outputDir, guard, waitMs, operations) {
  const held = async (operation, ...args) => {
    guard();
    const value = await operation(...args);
    guard();
    return value;
  };
  const recoveryRename = operations.recoveryRename ?? rename;
  guard();
  for (const name of await readdir(outputDir)) {
    guard();
    if (!name.startsWith(".BotFleet.transaction-")) continue;
    const directory = join(outputDir, name);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("Unverified recovery directory.");
    const entries = await readdir(directory);
    if (entries.length === 0 && /^\.BotFleet\.transaction-[A-Za-z0-9]{6}$/.test(name)) { await held(rmdir, directory); continue; }
    let journalPath = join(directory, "journal.json");
    let journalRecord = await readRecord(journalPath);
    const disposed = entries.filter((filename) => /^dispose-journal\.json-[0-9a-f-]{36}$/.test(filename));
    const temporary = entries.filter((filename) => /^journal-[0-9a-f-]{36}\.tmp$/.test(filename));
    if (disposed.length > 1 || temporary.length > 1 || (disposed.length && (journalRecord || temporary.length))) throw new Error("Ambiguous journal evidence preserved.");
    let previousJournal;
    if (temporary.length === 1) {
      previousJournal = journalRecord;
      journalPath = join(directory, temporary[0]);
      journalRecord = await held(readRecord, journalPath);
    } else if (!journalRecord && disposed.length === 1) {
      journalPath = join(directory, disposed[0]);
      journalRecord = await held(readRecord, journalPath);
    }
    guard();
    const journal = parseJournal(journalRecord, info);
    if (previousJournal) {
      const previous = parseJournal(previousJournal, info);
      if (previous.pid !== journal.pid || JSON.stringify(previous.initial) !== JSON.stringify(journal.initial)) throw new Error("Conflicting journal versions preserved.");
    }
    const deadline = Date.now() + waitMs;
    while (true) {
      guard();
      try { process.kill(journal.pid, 0); }
      catch (error) { if (error.code === "ESRCH") break; throw error; }
      if (journal.pid === process.pid || Date.now() >= deadline) throw new Error("A live transaction is still present.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const current = new Map(await Promise.all(NAMES.map(async (filename) => [filename, await readRecord(join(outputDir, filename))])));
    guard();
    if (temporary.length && !NAMES.every((filename) => matchesSerial(current.get(filename), journal.initial[filename]))) throw new Error("Journal temp is no longer pre-mutation.");
    // Validate all pre-existing entries before changing any active pathname.
    for (const entry of entries) {
      if (entry === basename(journalPath) || (previousJournal && entry === "journal.json")) continue;
      const { expected } = recoveryEntry(entry, journal);
      if (!matchesSerial(await held(readRecord, join(directory, entry)), expected)) throw new Error("Edited recovery residue preserved.");
    }
    const invalidating = journal.intent === "invalidate";
    const complete = !invalidating && NAMES.every((filename) => journal.staged[filename] && matchesSerial(current.get(filename), journal.staged[filename]));
    if (complete) validateReceipt(current);
    for (const filename of NAMES) {
      guard();
      const expected = journal.staged[filename];
      const active = join(outputDir, filename);
      if (invalidating && filename !== NAMES[2] && journal.initial[filename] && matchesSerial(current.get(filename), journal.initial[filename])) {
        const claimedPath = join(directory, `invalidate-${filename}-${randomUUID()}`);
        guard();
        await held(recoveryRename, active, claimedPath);
        guard();
        if (matchesSerial(await held(readRecord, claimedPath), journal.initial[filename])) await held(rm, claimedPath);
        else await held(link, claimedPath, active).then(() => held(rm, claimedPath)).catch((error) => { if (error.code !== "EEXIST") throw error; });
      }
      if (!complete && expected && matchesSerial(current.get(filename), expected)) {
        const claimedPath = join(directory, `recover-${filename}-${randomUUID()}`);
        guard();
        await held(recoveryRename, active, claimedPath);
        guard();
        if (matchesSerial(await held(readRecord, claimedPath), expected)) await held(rm, claimedPath);
        else {
          await held(link, claimedPath, active).then(() => held(rm, claimedPath)).catch((error) => { if (error.code !== "EEXIST") throw error; });
        }
      }
      const backupPath = join(directory, `old-${filename}`);
      const backup = await readRecord(backupPath);
      guard();
      if (backup !== null) {
        if (!matchesSerial(backup, journal.initial[filename])) throw new Error("Changed recovery backup preserved.");
        if (complete || (invalidating && filename !== NAMES[2])) await held(rm, backupPath);
        else {
          try { await held(link, backupPath, active); await held(rm, backupPath); }
          catch (error) {
            if (error.code !== "EEXIST") throw error;
            if (matchesSerial(await held(readRecord, active), journal.initial[filename])) await held(rm, backupPath);
          }
        }
      }
      const stagedPath = join(directory, `new-${filename}`);
      const stagedRecord = await readRecord(stagedPath);
      guard();
      if (stagedRecord !== null) {
        if (!expected || !matchesSerial(stagedRecord, expected)) throw new Error("Unverified staged recovery file preserved.");
        await held(rm, stagedPath);
      }
    }
    for (const residue of await readdir(directory)) {
      if (residue === basename(journalPath)) continue;
      if (previousJournal && residue === "journal.json") continue;
      const { filename, old, expected } = recoveryEntry(residue, journal);
      const residuePath = join(directory, residue);
      const record = await held(readRecord, residuePath);
      if (!expected || !matchesSerial(record, expected)) throw new Error("Edited recovery residue preserved.");
      if (old && !complete && !(invalidating && filename !== NAMES[2])) {
        const active = join(outputDir, filename);
        try { await held(link, residuePath, active); await held(rm, residuePath); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          if (matchesSerial(await held(readRecord, active), expected)) await held(rm, residuePath);
          else throw new Error("Concurrent output and its recovery copy preserved.");
        }
      } else await held(rm, residuePath);
    }
    if (previousJournal) {
      if (!sameRecord(await held(readRecord, join(directory, "journal.json")), previousJournal)) throw new Error("Previous journal changed.");
      await held(rm, join(directory, "journal.json"));
    }
    if ((await readdir(directory)).some((filename) => filename !== basename(journalPath))) throw new Error("Concurrent recovery files preserved.");
    guard();
    if (!sameRecord(await readRecord(journalPath), journalRecord)) throw new Error("Recovery journal changed.");
    await held(rm, journalPath);
    await held(rmdir, directory);
  }
}

export async function withCursorOutputTransaction({ homeDir, log, operations = {}, lockWaitMs = 30_000 }, action) {
  const outputDir = join(homeDir, ".cursor-cloud-env");
  let directoryIdentity;
  let assertHeld = () => {};
  const requireDirectory = async () => {
    assertHeld();
    const directory = await lstat(outputDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 ||
        (process.getuid && directory.uid !== process.getuid())) throw new Error("Output directory is not private and owned.");
    const identity = `${directory.dev}:${directory.ino}`;
    if (directoryIdentity && identity !== directoryIdentity) throw new Error("Output directory changed.");
    directoryIdentity = identity;
    assertHeld();
  };
  try {
    await mkdir(outputDir, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    await requireDirectory();
  } catch {
    log("Unverified output directory preserved; bootstrap unavailable.");
    return { state: "unavailable", count: 0 };
  }
  let releaseLock;
  try { const lock = await acquireOsLock(outputDir, lockWaitMs, operations); releaseLock = lock.release; assertHeld = lock.assertHeld; }
  catch {
    log("Private OS output lock unavailable; existing files preserved.");
    return { state: "unavailable", count: 0 };
  }
  let transaction;
  const staged = new Map();
  const claimed = new Map();
  const published = new Map();
  const claimRename = operations.rename ?? rename;
  const publishLink = operations.link ?? link;
  const cleanupRename = operations.cleanupRename ?? rename;
  const cleanupRemove = operations.remove ?? rm;
  const journalRename = operations.journalRename ?? rename;
  let journalRecord;
  let intent = "pending";

  const restore = async (from, to) => {
    try { assertHeld(); await link(from, to); assertHeld(); await rm(from); assertHeld(); return true; }
    catch (error) { if (error.code === "ENOENT") return true; if (error.code === "EEXIST") return false; throw error; }
  };
  const removeMatching = async (path, expected) => {
    assertHeld();
    if (dirname(path) !== transaction) throw new Error("Cleanup requires a private transaction path.");
    // Every caller passes this invocation's private quarantine/staging path.
    // Claim it again so replacing its former pathname cannot redirect unlink.
    const disposal = join(transaction, `dispose-${basename(path)}-${randomUUID()}`);
    try { await cleanupRename(path, disposal); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    const current = await readRecord(disposal).catch(() => null);
    assertHeld();
    if (!sameRecord(current, expected)) { await restore(disposal, path); return false; }
    await cleanupRemove(disposal);
    assertHeld();
    return true;
  };
  const restoreClaims = async () => {
    for (const [name, path] of [...claimed].reverse()) {
      if (await restore(path, join(outputDir, name))) claimed.delete(name);
    }
  };
  const clearPublished = async () => {
    for (const [name, expected] of published) {
      assertHeld();
      const quarantined = join(transaction, `failed-${name}-${randomUUID()}`);
      try { await rename(join(outputDir, name), quarantined); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const current = await readRecord(quarantined).catch(() => null);
      assertHeld();
      if (sameRecord(current, expected)) await rm(quarantined);
      else await restore(quarantined, join(outputDir, name));
    }
    published.clear();
  };

  try {
    await requireDirectory();
    await recoverTransactions(outputDir, assertHeld, lockWaitMs, operations);
    assertHeld();
    transaction = await mkdtemp(join(outputDir, ".BotFleet.transaction-"));
    const initial = new Map(await Promise.all(NAMES.map(async (name) => [name, await readRecord(join(outputDir, name))])));
    validateReceipt(initial);
    const transactionStat = await lstat(transaction);
    const writeJournal = async () => {
      assertHeld();
      const value = JSON.stringify({ owner: OWNER, version: 1, pid: process.pid, intent,
        directory: `${transactionStat.dev}:${transactionStat.ino}`,
        initial: Object.fromEntries([...initial].map(([name, record]) => [name, serial(record)])),
        staged: Object.fromEntries([...staged].map(([name, entry]) => [name, serial(entry.record)])),
      }) + "\n";
      const temporary = join(transaction, `journal-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try { assertHeld(); await file.writeFile(value); assertHeld(); await file.sync(); assertHeld(); } finally { await file.close(); }
      await journalRename(temporary, join(transaction, "journal.json"));
      assertHeld();
      journalRecord = await readRecord(join(transaction, "journal.json"));
    };
    await writeJournal();

    const claimAll = async () => {
      if (claimed.size) throw new Error("An earlier recovery is still preserved.");
      await requireDirectory();
      for (const name of NAMES) {
        assertHeld();
        const path = join(transaction, `old-${name}`);
        try {
          await claimRename(join(outputDir, name), path);
          assertHeld();
          claimed.set(name, path);
        } catch (error) {
          if (error.code !== "ENOENT" || initial.get(name) !== null) throw error;
          continue;
        }
        if (!sameRecord(await readRecord(path), initial.get(name))) throw new Error("An output changed before atomic claim.");
      }
    };
    const invalidate = async () => {
      try {
        assertHeld();
        intent = "invalidate";
        await writeJournal();
        await claimAll();
        for (const name of NAMES.slice(0, 2)) {
          const path = claimed.get(name);
          if (path && await removeMatching(path, initial.get(name))) claimed.delete(name);
        }
        await restoreClaims();
        if (claimed.size) throw new Error("Concurrent output preserved with its backup.");
      } catch (error) { await restoreClaims(); throw error; }
    };
    const publish = async (environment, source, manifest) => {
      const contents = [environment, source, manifest];
      try {
        for (const [index, name] of NAMES.entries()) {
          const path = join(transaction, `new-${name}`);
          const file = await open(path, "wx", 0o600);
          try { assertHeld(); await file.writeFile(contents[index]); assertHeld(); await file.sync(); assertHeld(); } finally { await file.close(); }
          staged.set(name, { path, record: await readRecord(path) });
        }
        intent = "publish";
        await writeJournal();
        await claimAll();
        for (const name of NAMES) {
          const entry = staged.get(name);
          await requireDirectory();
          published.set(name, entry.record);
          await publishLink(entry.path, join(outputDir, name));
          assertHeld();
        }
        for (const [name, path] of claimed) {
          if (await removeMatching(path, initial.get(name))) claimed.delete(name);
        }
        if (claimed.size) throw new Error("Changed backup preserved.");
      } catch (error) { await clearPublished(); await restoreClaims(); throw error; }
    };
    assertHeld();
    const result = await action({ guard: assertHeld, invalidate, publish, readEnvironment: () => {
      assertHeld();
      if (!initial.get(NAMES[0]) || !initial.get(NAMES[1])) throw new Error("Environment generation is incomplete.");
      return { state: "read", count: 0, environmentText: initial.get(NAMES[0]).content };
    } });
    assertHeld();
    return result;
  } catch {
    await clearPublished();
    await restoreClaims();
    log("Unverified or concurrently changed outputs preserved; bootstrap unavailable.");
    return { state: "unavailable", count: 0 };
  } finally {
    try {
    for (const { path, record } of staged.values()) await removeMatching(path, record);
    if (transaction) {
      const entries = await readdir(transaction);
      if (entries.every((name) => name === "journal.json") && journalRecord) await removeMatching(join(transaction, "journal.json"), journalRecord);
      await rmdir(transaction).catch((error) => {
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
        log("Private recovery files preserved after a concurrent change.");
      });
    }
    } finally { await releaseLock(); }
  }
}

if (process.argv[2] === "--read-environment" && process.argv[1] &&
    realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const result = await withCursorOutputTransaction({ homeDir: process.argv[3], log: () => {} }, ({ readEnvironment }) => readEnvironment());
  if (result.state === "read") process.stdout.write(result.environmentText);
  else process.exitCode = 1;
}
