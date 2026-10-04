// node:test coverage for the cross-process config.json lock.  The race
// tests spawn real Node processes: a synchronous lock cannot be raced from
// inside one event loop, and the bug it closes (PR #251 review, board
// a2a3a586) is between the harness server and the Electron main process --
// two OS processes -- so that is what gets exercised.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_LOCK_STALE_MS,
  acquireConfigFileLock,
  lockPathFor,
  readConfigFile,
  updateConfigFile,
  withConfigFileLock,
  writeFileAtomic,
} from "./config-file-lock.mjs";

const MODULE_URL = new URL("./config-file-lock.mjs", import.meta.url).href;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-config-lock-"));
  return { dir, path: join(dir, "config.json") };
}

/** A pid that is certainly not alive: a child that has already exited.
 * Pids are not recycled quickly enough for this to be anything else. */
function deadPid() {
  const gone = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(gone.status, 0);
  return gone.pid;
}

/** Run an ES-module body in a fresh Node process with the lock module bound
 * as `mod` and `env` merged into its environment.  Resolves with stdout on
 * exit 0.  `onLine` sees each stdout line as it arrives, for handshakes. */
function runWorker(source, env, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", `import * as mod from ${JSON.stringify(MODULE_URL)};\n${source}`],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (onLine) for (const line of String(chunk).split("\n")) if (line) onLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
}

/** A worker that takes the lock, announces it, holds it for CFL_HOLD_MS
 * while writing a marker straight into the file, then releases. */
const HOLDER_SOURCE = `
const path = process.env.CFL_PATH;
const lock = mod.acquireConfigFileLock(path);
console.log("locked");
await new Promise((r) => setTimeout(r, Number(process.env.CFL_HOLD_MS)));
mod.writeFileAtomic(path, JSON.stringify({ holder: "worker" }));
lock.release();
console.log("released");
`;

/** A worker that increments its own section's counter CFL_N times through
 * the locked read-modify-write -- the shape of every real config writer. */
const COUNTER_SOURCE = `
const path = process.env.CFL_PATH;
const section = process.env.CFL_SECTION;
const options = { timeoutMs: Number(process.env.CFL_TIMEOUT_MS ?? 5000) };
for (let i = 0; i < Number(process.env.CFL_N); i += 1) {
  mod.updateConfigFile(path, (disk) => {
    const current = disk[section] ?? { count: 0 };
    disk[section] = { count: current.count + 1 };
  }, options);
}
console.log("done");
`;

/** A real peer takes over an aged lock, then waits until the suspended
 * holder has been checked before releasing its own healthy lease. */
const TAKEOVER_SOURCE = `
import { existsSync } from "node:fs";
const path = process.env.CFL_PATH;
const lock = mod.acquireConfigFileLock(path, { timeoutMs: 3000 });
try {
  mod.writeFileAtomic(path, JSON.stringify({ holder: "peer" }));
  console.log("took");
  const deadline = Date.now() + 10000;
  while (!existsSync(process.env.CFL_RELEASE_PATH)) {
    if (Date.now() >= deadline) throw new Error("parent did not acknowledge takeover");
    await new Promise((r) => setTimeout(r, 10));
  }
} finally {
  lock.release();
}
console.log("released");
`;

function waitForLine(wanted) {
  let resolveLine;
  const seen = new Promise((resolve) => {
    resolveLine = resolve;
  });
  return {
    seen,
    onLine: (line) => {
      if (line === wanted) resolveLine();
    },
  };
}

test("updateConfigFile starts from an empty object when the file is missing or not a JSON object", () => {
  const { dir, path } = tempConfig();
  try {
    let seen;
    updateConfigFile(path, (disk) => {
      seen = { ...disk };
      disk.first = true;
    });
    assert.deepEqual(seen, {});
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { first: true });

    writeFileSync(path, "{ not json");
    updateConfigFile(path, (disk) => {
      seen = { ...disk };
      disk.second = true;
    });
    assert.deepEqual(seen, {});
    assert.deepEqual(readConfigFile(path), { second: true });

    writeFileSync(path, "[1,2,3]");
    assert.deepEqual(readConfigFile(path), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile leaves the file untouched when mutate returns null", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, '{"keep":1}');
    const result = updateConfigFile(path, () => null);
    assert.deepEqual(result, { keep: 1 });
    assert.equal(readFileSync(path, "utf8"), '{"keep":1}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile accepts a replacement object and rejects an async mutate", () => {
  const { dir, path } = tempConfig();
  try {
    updateConfigFile(path, (disk) => ({ ...disk, replaced: true }));
    assert.deepEqual(readConfigFile(path), { replaced: true });
    assert.throws(() => updateConfigFile(path, async () => {}), /must be synchronous/);
    assert.equal(existsSync(lockPathFor(path)), false, "lock released after the rejected call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the lock is released after the update, including when mutate throws", () => {
  const { dir, path } = tempConfig();
  try {
    updateConfigFile(path, (disk) => {
      disk.ok = true;
      assert.equal(existsSync(lockPathFor(path)), true, "lock held while mutating");
    });
    assert.equal(existsSync(lockPathFor(path)), false);
    assert.throws(
      () =>
        updateConfigFile(path, () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(existsSync(lockPathFor(path)), false, "lock released after the throw");
    assert.deepEqual(readConfigFile(path), { ok: true }, "a throwing mutate writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic runs beforeRename after staging and drops the staged file when it throws", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, '{"before":true}');
    let stagedSeen = false;
    assert.throws(
      () =>
        writeFileAtomic(path, '{"after":true}', {
          beforeRename: () => {
            // The temp file is fully written and fsynced by now; the target
            // is still the old contents.
            stagedSeen = readdirSync(dir).some((name) => name.startsWith("config.json.") && name.endsWith(".tmp"));
            assert.equal(readFileSync(path, "utf8"), '{"before":true}');
            throw new Error("fence says no");
          },
        }),
      /fence says no/,
    );
    assert.equal(stagedSeen, true, "the hook ran with the temp file staged");
    assert.equal(readFileSync(path, "utf8"), '{"before":true}', "the target was not replaced");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "the staged file was removed");
    writeFileAtomic(path, '{"after":true}', { beforeRename: () => {} });
    assert.equal(readFileSync(path, "utf8"), '{"after":true}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-entering the lock from a handle this process still holds throws instead of hanging", () => {
  const { dir, path } = tempConfig();
  try {
    assert.throws(
      () => withConfigFileLock(path, () => updateConfigFile(path, () => null)),
      /re-entered by this process/,
    );
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record with this process's pid but no live handle is taken over, not refused as re-entry", () => {
  const { dir, path } = tempConfig();
  try {
    // The shape a release leaves behind when its unlink was refused: our
    // own pid, fresh, but nothing in this process holds it.
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: process.pid, at: Date.now(), released: true }));
    const started = Date.now();
    updateConfigFile(path, (disk) => {
      disk.recovered = true;
    }, { timeoutMs: 2_000 });
    assert.ok(Date.now() - started < 1_500, "taken over at once");
    assert.deepEqual(readConfigFile(path), { recovered: true });
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock left behind by a dead process is taken over", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: deadPid(), at: Date.now() }));
    const started = Date.now();
    updateConfigFile(path, (disk) => {
      disk.reclaimed = true;
    }, { timeoutMs: 2_000 });
    assert.ok(Date.now() - started < 1_500, "taken over without waiting out the timeout");
    assert.deepEqual(readConfigFile(path), { reclaimed: true });
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lock older than staleMs is taken over even when its pid is alive", (t) => {
  // Filesystem scheduling must not spend the newly acquired lease.  The
  // cross-process race tests below retain the real clock.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { dir, path } = tempConfig();
  try {
    assert.ok(CONFIG_LOCK_STALE_MS > 0);
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: process.pid, at: Date.now() - 500 }));
    updateConfigFile(path, (disk) => {
      disk.aged = true;
    }, { staleMs: 100, timeoutMs: 1_000 });
    assert.deepEqual(readConfigFile(path), { aged: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable lock file older than staleMs is taken over, a fresh one is waited on", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(lockPathFor(path), "garbage");
    // Fresh garbage: nobody can prove it stale yet, so the writer times out.
    assert.throws(
      () => updateConfigFile(path, () => null, { staleMs: 10_000, timeoutMs: 150 }),
      /held by an unknown writer/,
    );
    // The same garbage once it is old enough (its mtime is all there is to
    // judge by): taken over and written through.
    const past = new Date(Date.now() - 10_000);
    utimesSync(lockPathFor(path), past, past);
    updateConfigFile(path, (disk) => {
      disk.after = true;
    }, { staleMs: 1_000, timeoutMs: 1_000 });
    assert.deepEqual(readConfigFile(path), { after: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer waits for a live lock held by another process instead of writing under it", async () => {
  const { dir, path } = tempConfig();
  try {
    const locked = waitForLine("locked");
    const holder = runWorker(HOLDER_SOURCE, { CFL_PATH: path, CFL_HOLD_MS: "400" }, locked.onLine);
    await locked.seen;
    // The peer holds the lock and has not written yet.  Without waiting this
    // update would read {} and its rename would erase the peer's marker.
    const result = updateConfigFile(path, (disk) => {
      disk.waiter = true;
    });
    await holder;
    assert.deepEqual(result, { holder: "worker", waiter: true });
    assert.deepEqual(readConfigFile(path), { holder: "worker", waiter: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a writer gives up with a clear error after timeoutMs while a peer holds the lock", async () => {
  const { dir, path } = tempConfig();
  try {
    const locked = waitForLine("locked");
    const holder = runWorker(HOLDER_SOURCE, { CFL_PATH: path, CFL_HOLD_MS: "700" }, locked.onLine);
    await locked.seen;
    assert.throws(
      () => acquireConfigFileLock(path, { timeoutMs: 100 }),
      /config lock held by pid \d+ for more than 100 ms/,
    );
    await holder;
    assert.deepEqual(readConfigFile(path), { holder: "worker" }, "the holder's write survived");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The lease is what makes taking over safe.  A holder that was suspended
// past the stale window (system sleep, a debugger, a filesystem stall) must
// not land the snapshot it read before it was suspended.
test("a holder whose lease ran out refuses to write and leaves its lock for the takeover", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, '{"fresh":true}');
    assert.throws(
      () =>
        updateConfigFile(
          path,
          (disk) => {
            t.mock.timers.tick(120); // "suspended" inside the critical section
            disk.stale = true;
          },
          { staleMs: 50, timeoutMs: 500 },
        ),
      /lease expired/,
    );
    assert.deepEqual(readConfigFile(path), { fresh: true }, "nothing was written");
    // Past its lease the handle no longer unlinks by name (a peer may be
    // taking the lock over); the lock is left for that takeover instead.
    assert.equal(existsSync(lockPathFor(path)), true, "the expired lock is left in place");
    updateConfigFile(path, (disk) => {
      disk.later = true;
    }, { staleMs: 50, timeoutMs: 1_000 });
    assert.deepEqual(readConfigFile(path), { fresh: true, later: true });
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release inside the lease unlinks; one past the usable lease leaves the lock to the takeover", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { dir, path } = tempConfig();
  try {
    acquireConfigFileLock(path, { staleMs: 400 }).release();
    assert.equal(existsSync(lockPathFor(path)), false, "released inside the lease");
    const late = acquireConfigFileLock(path, { staleMs: 400 });
    t.mock.timers.tick(330); // inside staleMs but past the 100 ms margin
    late.release();
    assert.equal(existsSync(lockPathFor(path)), true, "left in place rather than unlinked by name");
    // Once the remaining lease passes, the next writer takes over.
    t.mock.timers.tick(71);
    updateConfigFile(path, (disk) => {
      disk.next = true;
    }, { staleMs: 400, timeoutMs: 2_000 });
    assert.deepEqual(readConfigFile(path), { next: true });
    assert.equal(existsSync(lockPathFor(path)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a suspended holder whose lock a peer took over cannot write over the peer or drop its lock", async (t) => {
  const { dir, path } = tempConfig();
  const releasePath = join(dir, "release-peer");
  let peer;
  try {
    // Age only the parent fixture.  The separate peer uses real time and
    // the production lease, so scheduling delays cannot expire a 400 ms
    // lease before the peer has a chance to release it.
    const now = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: now - CONFIG_LOCK_STALE_MS - 1000 });
    const suspended = acquireConfigFileLock(path);
    t.mock.timers.setTime(now);
    const took = waitForLine("took");
    peer = runWorker(TAKEOVER_SOURCE, { CFL_PATH: path, CFL_RELEASE_PATH: releasePath }, took.onLine);
    // A startup failure must reject instead of waiting forever for stdout.
    await Promise.race([took.seen, peer.then(() => { throw new Error("peer exited before takeover"); })]);
    assert.throws(() => suspended.assertHeld(), /lease expired|taken over by another writer/);
    suspended.release();
    assert.equal(existsSync(lockPathFor(path)), true, "the peer's lock survives the stale holder's release");
    writeFileSync(releasePath, "checked");
    await peer;
    assert.equal(existsSync(lockPathFor(path)), false, "the peer's own release removed it");
    assert.deepEqual(readConfigFile(path), { holder: "peer" });
  } finally {
    writeFileSync(releasePath, "cleanup");
    await peer?.catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

// Several writers wake up behind one abandoned lock.  Only one of them can
// win the O_EXCL ticket for that generation, and only the winner may
// replace it, so a waiter can never remove or overwrite the lock a peer
// just created; the rest see a fresh live lock and simply wait their turn.
test("several writers behind one dead-pid lock all get through without losing an update", async () => {
  const { dir, path } = tempConfig();
  const N = 20;
  const sections = ["a", "b", "c", "d"];
  try {
    writeFileSync(lockPathFor(path), JSON.stringify({ pid: deadPid(), at: Date.now() }));
    const env = { CFL_PATH: path, CFL_N: String(N), CFL_TIMEOUT_MS: "30000" };
    await Promise.all(sections.map((section) => runWorker(COUNTER_SOURCE, { ...env, CFL_SECTION: section })));
    const final = readConfigFile(path);
    assert.deepEqual(final, Object.fromEntries(sections.map((section) => [section, { count: N }])));
    assert.equal(existsSync(lockPathFor(path)), false, "no lock left behind");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no temp files left behind");
    assert.equal(
      readdirSync(dir).filter((name) => name.includes(".takeover.")).length,
      1,
      "exactly one takeover ticket, for the one generation that was taken over",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The regression test for the lost-update race itself.  Two processes hammer
// the same file with read-modify-writes of their own sections.  Without the
// lock, one side's stale snapshot regularly lands on top of the other's
// fresh write and a counter comes up short; with it, both reach N exactly.
test("two processes doing locked read-modify-writes on one file never lose an update", async () => {
  const { dir, path } = tempConfig();
  const N = 40;
  try {
    const env = { CFL_PATH: path, CFL_N: String(N) };
    await Promise.all([
      runWorker(COUNTER_SOURCE, { ...env, CFL_SECTION: "server" }),
      runWorker(COUNTER_SOURCE, { ...env, CFL_SECTION: "electron" }),
    ]);
    const final = readConfigFile(path);
    assert.deepEqual(final, { server: { count: N }, electron: { count: N } });
    assert.equal(existsSync(lockPathFor(path)), false, "no lock left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An unusable config.json used to read as `{}`, so the next writer (a Settings
// save, the updater's throttle record, a boot credential migration) replaced
// the file with its patch alone and every key the owner had was gone.  Now the
// unusable file is renamed aside first, under the same lock, and never
// deleted.

const setAsideNames = (dir) => readdirSync(dir).filter((name) => name.startsWith("config.json.corrupt-"));

test("updateConfigFile sets an unparseable file aside, byte for byte, before writing a new one", () => {
  const { dir, path } = tempConfig();
  try {
    const broken = '{"xai":{"key":"REDACTED_TEST_MARKER"},"profile":{"name":"Ada"';
    writeFileSync(path, broken, { mode: 0o600 });
    const notices = [];
    let seen;
    updateConfigFile(
      path,
      (disk) => {
        seen = { ...disk };
        disk.second = true;
      },
      { now: 1790000000000, onSetAside: (info) => notices.push(info) },
    );
    assert.deepEqual(seen, {});
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { second: true });
    assert.deepEqual(setAsideNames(dir), ["config.json.corrupt-1790000000000"]);
    const aside = join(dir, "config.json.corrupt-1790000000000");
    assert.equal(readFileSync(aside, "utf8"), broken);
    // The mode is only meaningful where the filesystem has permission bits.
    // NTFS has none, so statSync reports 0o666 for every file there and
    // writeFileSync ignores its mode option; asserting it would be asserting a
    // property Windows does not have, and did not have when this branch first
    // ran there.
    if (process.platform !== "win32") {
      assert.equal(statSync(aside).mode & 0o777, 0o600, "the preserved file keeps its private mode");
    }
    assert.equal(notices.length, 1);
    assert.equal(notices[0].setAsidePath, aside);
    assert.match(notices[0].reason, /ends early|not valid JSON/);
    assert.ok(!notices[0].reason.includes("REDACTED_TEST_MARKER"), "the reason never quotes the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile sets aside a JSON value that is not an object, and never reuses a name", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, "[1,2,3]");
    writeFileSync(join(dir, "config.json.corrupt-1790000000000"), "earlier");
    updateConfigFile(path, (disk) => {
      disk.fresh = true;
    }, { now: 1790000000000, onSetAside: () => {} });
    assert.deepEqual(setAsideNames(dir).sort(), [
      "config.json.corrupt-1790000000000",
      "config.json.corrupt-1790000000000-1",
    ]);
    assert.equal(readFileSync(join(dir, "config.json.corrupt-1790000000000"), "utf8"), "earlier");
    assert.equal(readFileSync(join(dir, "config.json.corrupt-1790000000000-1"), "utf8"), "[1,2,3]");
    assert.deepEqual(readConfigFile(path), { fresh: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile treats a byte-order mark as part of a healthy file", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, `\uFEFF${JSON.stringify({ keep: { me: 1 } })}`);
    assert.deepEqual(readConfigFile(path), { keep: { me: 1 } });
    updateConfigFile(path, (disk) => {
      disk.added = true;
    });
    assert.deepEqual(setAsideNames(dir), []);
    const text = readFileSync(path, "utf8");
    assert.ok(!text.startsWith("\uFEFF"));
    assert.deepEqual(JSON.parse(text), { keep: { me: 1 }, added: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile does not set aside an empty file, which holds nothing to lose", () => {
  const { dir, path } = tempConfig();
  try {
    for (const body of ["", "  \n"]) {
      writeFileSync(path, body);
      updateConfigFile(path, (disk) => {
        disk.ok = true;
      });
      assert.deepEqual(setAsideNames(dir), []);
      assert.deepEqual(readConfigFile(path), { ok: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile leaves an unusable file exactly where it is when nothing needs writing", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, "{ not json");
    updateConfigFile(path, () => null);
    assert.equal(readFileSync(path, "utf8"), "{ not json");
    assert.deepEqual(setAsideNames(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigFile refuses to overwrite an unusable file it cannot set aside", () => {
  const { dir, path } = tempConfig();
  try {
    writeFileSync(path, "{ not json");
    // A name longer than the filesystem allows makes the rename fail the same
    // way a read-only directory would, without depending on who runs the test.
    // That limit is a POSIX name-length rule though, and NTFS with long paths
    // enabled accepts the name — so on the first Windows run of this branch
    // the rename went through, nothing was refused, and this reported a
    // missing exception while proving nothing.  Ask, then check the answer.
    let refused = false;
    try {
      updateConfigFile(path, (disk) => {
        disk.fresh = true;
      }, { now: "9".repeat(400) });
    } catch (error) {
      refused = true;
      assert.match(String(error), /config\.json/);
    }
    if (!refused) {
      // The platform allowed the oversized name, so the refusal was never set up.  Assert the
      // outcome it did produce rather than returning silently: a lock that was not released, or a
      // staged file left behind, would otherwise pass here.  POSIX takes the branch below on
      // every run.
      const moved = join(dir, `config.json.corrupt-${"9".repeat(400)}`);
      assert.ok(existsSync(moved), "the unusable file was moved aside under the long name");
      assert.equal(readFileSync(moved, "utf8"), "{ not json", "the moved file is byte for byte");
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { fresh: true });
      assert.equal(existsSync(lockPathFor(path)), false, "the lock is released");
      assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no staged file is left behind");
      return;
    }
    assert.equal(readFileSync(path, "utf8"), "{ not json", "the unusable file is untouched");
    assert.equal(existsSync(lockPathFor(path)), false, "the lock is released");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), [], "no staged file is left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
