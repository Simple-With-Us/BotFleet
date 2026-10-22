// The fence step of apply: hold new work, give what is running a grace, then
// pause what is left — or, with --wait-for-idle, wait and never interrupt.
//
// Every test drives `fenceRuntimeAdmission` against a scripted harness and a
// fake clock, so a 60-second grace or a 20-minute wait runs in milliseconds and
// nothing here touches a real harness, port or launchd job.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureProcessIdentities,
  DEFAULT_GRACE_MS,
  DEFAULT_ROOM_WAIT_MS,
  describeWindow,
  drainProgressDetail,
  ensureBotFleetRunning,
  fenceMode,
  fenceRuntimeAdmission,
  keepFenceLease,
  parseArguments,
  pauseTimeoutMessage,
  releaseRuntimeAdmission,
  retryTransient,
  rollbackReadinessError,
  rollbackFenceConfig,
  runtimePreflight,
  settledDatabaseHolders,
  terminateVerified,
  UnrecognizedHolderError,
  waitForIdleTimeoutMessage,
  waitOutUnrecognizedHolders,
  waitForBotFleetExit,
  DEFAULT_EXIT_WAIT_MS,
} from "./update-botfleet-mac.mjs";

const OWNER = { version: 1, pid: 42, port: 8799, nonce: "a".repeat(64) };
const IDENTITY = {
  app: "botfleet",
  pid: 42,
  dataOwner: { pid: 42, port: 8799 },
  sourceCommit: "b".repeat(40),
  sourceDirty: false,
};

/**
 * A harness that answers the way server/index.ts does.  `inFlight` and
 * `rooms` are read on every answer, so a test changes them as time passes.
 */
function scriptedHarness({
  drains = true,
  // The harness installed before this updater never reports `fencing`, and
  // raises `quiescing` before it starts interrupting anything.
  reportsFencing = true,
  inFlight = () => 0,
  rooms = () => 0,
  bots,
  forceRefusals = 0,
  // A forced answer that times out on the updater's side while the harness
  // carries on, still settling until the clock reaches this.
  loseForcedAnswerUntil,
  // That lost forced quiesce rolls itself back when it settles, instead of
  // holding the fence.
  rollsBack = false,
  // The first hold request's answer is lost this many times.
  loseFirstAnswers = 0,
  // The harness keeps a lease on its fence (server/index.ts armFenceLease).
  leases = false,
  // Called with each request before it is answered: a test sends a signal
  // from inside one, the way Ctrl-C lands while a request is in flight.
  onRequest = () => {},
} = {}) {
  let clock = 0;
  let firstAnswersLost = 0;
  let fencingUntil = null;
  const state = {
    draining: false,
    quiescing: false,
    // The fence settled: what was running was interrupted and saved.
    fenced: false,
    releasePending: false,
    released: 0,
    releasedAt: [],
    forced: 0,
    plain: 0,
    polls: 0,
    requests: [],
    renewals: 0,
    lease: null,
  };
  const fencing = () => fencingUntil !== null && clock < fencingUntil;
  const release = () => {
    state.released += 1;
    state.releasedAt.push(clock);
    state.draining = false;
    state.quiescing = false;
    state.fenced = false;
    state.lease = null;
  };
  // Time passing settles a forced quiesce, and honours a release it deferred.
  const settle = () => {
    if (fencingUntil === null || clock < fencingUntil) return;
    fencingUntil = null;
    if (rollsBack) state.quiescing = false;
    else state.fenced = true;
    if (state.releasePending) {
      state.releasePending = false;
      release();
    }
  };
  const work = () => (state.fenced ? 0 : inFlight(clock));
  const drain = () => ({
    inFlight: inFlight(clock),
    bots: bots ? bots(clock) : inFlight(clock),
    rooms: rooms(clock),
    held: { routineRuns: 0, sends: 0 },
  });
  const body = (extra = {}) => {
    const answer = {
      ...IDENTITY,
      safeToRestart: work() === 0,
      activeWorkCount: work(),
      quiescing: state.quiescing,
    };
    if (reportsFencing) answer.fencing = fencing();
    if (leases) answer.lease = state.lease;
    // An older harness has never heard of a hold, so says nothing about one.
    if (drains) Object.assign(answer, { draining: state.draining, drain: state.draining ? drain() : null });
    return { ...answer, ...extra };
  };
  let refusalsLeft = forceRefusals;
  const requestJson = async (url, options = {}) => {
    settle();
    const method = options.method ?? "GET";
    const { pathname, searchParams } = new URL(url);
    state.requests.push(`${method} ${pathname}${searchParams.size ? `?${searchParams}` : ""}`);
    onRequest(method, searchParams);
    if (leases && searchParams.get("renew") === "1") {
      state.renewals += 1;
      const renewed = state.quiescing && !fencing();
      if (renewed) state.lease = { expiresAt: clock + Number(searchParams.get("leaseMs")) };
      return { kind: "ok", status: 200, body: body({ renewed }) };
    }
    if (leases && searchParams.get("leaseMs")) {
      // Armed once the request settles on a fence, as the route does.
      queueMicrotask(() => {
        if (state.quiescing && !fencing()) state.lease ??= { expiresAt: clock + Number(searchParams.get("leaseMs")) };
      });
    }
    if (method === "GET" && pathname === "/api/runtime") {
      state.polls += 1;
      return { kind: "ok", status: 200, body: body() };
    }
    if (method === "DELETE") {
      if (fencing() && reportsFencing) {
        // server/index.ts endRuntimeQuiesce: deferred to the settle.
        state.releasePending = true;
        return { kind: "ok", status: 200, body: body({ releasePending: true, safeToRestart: false }) };
      }
      release();
      return { kind: "ok", status: 200, body: body() };
    }
    const force = searchParams.get("force") === "true";
    if (force && fencing()) {
      // A second forced ask while the first settles: the current harness says
      // "not yet"; the installed one answers its readiness under the fence.
      state.forced += 1;
      return { kind: "ok", status: reportsFencing || work() !== 0 ? 409 : 200, body: body() };
    }
    if (force && loseForcedAnswerUntil !== undefined && fencingUntil === null && !state.fenced) {
      state.forced += 1;
      state.quiescing = true;
      state.draining = false;
      fencingUntil = loseForcedAnswerUntil;
      return { kind: "unavailable", reason: "TimeoutError" };
    }
    if (force) {
      state.forced += 1;
      if (rooms(clock) > 0 || refusalsLeft > 0) {
        if (rooms(clock) === 0) refusalsLeft -= 1;
        return { kind: "ok", status: 409, body: body() };
      }
      state.quiescing = true;
      state.fenced = true;
      state.draining = false;
      return { kind: "ok", status: 200, body: body() };
    }
    if (searchParams.get("drain") === "1" && drains) {
      state.draining = true;
      if (firstAnswersLost < loseFirstAnswers) {
        firstAnswersLost += 1;
        return { kind: "unavailable", reason: "TimeoutError" };
      }
      return { kind: "ok", status: 200, body: body() };
    }
    // A plain quiesce: converts a drain, or fences an idle harness.
    state.plain += 1;
    if (inFlight(clock) === 0) {
      state.quiescing = true;
      state.fenced = true;
      state.draining = false;
      return { kind: "ok", status: 200, body: body() };
    }
    return { kind: "ok", status: 409, body: body() };
  };
  const adapters = {
    readOwner: async () => OWNER,
    requestJson,
    healthTopology: async () => ({ safe: true, pid: 42, pids: [42], port: 8799, health: [] }),
    sqliteHolders: async () => [42],
    now: () => clock,
    sleep: async (ms) => {
      clock += Math.max(ms, 1);
    },
    report: (detail) => state.reports.push(detail),
    signals: null,
  };
  state.reports = [];
  return { state, adapters, clock: () => clock };
}

const config = (extra = {}) => ({ dataDirectory: "/private/data", ports: [8799], drainPollMs: 5_000, ...extra });

test("work that finishes inside the grace is fenced without interrupting anything", async () => {
  const harness = scriptedHarness({ inFlight: (t) => (t < 15_000 ? 2 : 0) });
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, true);
  assert.equal(harness.state.forced, 0, "nothing was forced");
  assert.equal(harness.state.released, 0);
  assert.equal(harness.state.quiescing, true);
  assert.ok(harness.clock() < DEFAULT_GRACE_MS);
  assert.deepEqual(harness.state.reports, ["Waiting for 2 bots to finish"]);
  // The hold came first: the very first request asked for it.
  assert.match(harness.state.requests[0], /^POST \/api\/runtime\/quiesce\?drain=1&timeoutMs=\d+$/);
});

test("work still running after the grace is paused and resumed, never waited on", async () => {
  const harness = scriptedHarness({ inFlight: () => 3 });
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, true);
  assert.equal(harness.state.forced, 1);
  assert.equal(harness.state.released, 0);
  // Forced right at the end of the grace, not a moment of extra waiting.
  assert.equal(harness.clock(), DEFAULT_GRACE_MS);
  assert.deepEqual(harness.state.reports, ["Waiting for 3 bots to finish"]);
});

test("the grace is configurable, and zero pauses at once", async () => {
  const short = scriptedHarness({ inFlight: () => 1 });
  assert.equal((await fenceRuntimeAdmission(config({ graceMs: 90_000 }), short.adapters)).safe, true);
  assert.equal(short.clock(), 90_000);

  const none = scriptedHarness({ inFlight: () => 1 });
  assert.equal((await fenceRuntimeAdmission(config({ graceMs: 0 }), none.adapters)).safe, true);
  assert.equal(none.state.forced, 1);
  assert.equal(none.clock(), 0);
});

test("a live room turn is waited for before forcing, then the update goes ahead", async () => {
  const harness = scriptedHarness({ inFlight: () => 2, rooms: (t) => (t < 100_000 ? 1 : 0) });
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, true);
  // Never asked to force while the room turn ran: that would only be refused.
  assert.equal(harness.state.forced, 1);
  assert.ok(harness.clock() >= 100_000);
  assert.ok(harness.state.reports.includes("Waiting for 1 room conversation to finish"));
});

test("a room that never goes quiet ends the run bounded, with everything released", async () => {
  const harness = scriptedHarness({ inFlight: () => 1, rooms: () => 1 });
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, false);
  assert.match(result.reason, /room conversation was still running after 6 minutes/);
  assert.match(result.reason, /Nothing was interrupted/);
  assert.equal(harness.state.forced, 0);
  assert.equal(harness.state.released, 1, "the hold is lifted");
  assert.equal(harness.state.draining, false);
  assert.equal(harness.clock(), DEFAULT_GRACE_MS + DEFAULT_ROOM_WAIT_MS);
});

test("a forced attempt the harness refuses is retried, spaced out, inside the bound", async () => {
  const harness = scriptedHarness({ inFlight: () => 1, forceRefusals: 2 });
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, true);
  assert.equal(harness.state.forced, 3);
  // Two refusals, each followed by a 30-second pause before the next try.
  assert.equal(harness.clock(), DEFAULT_GRACE_MS + 60_000);
});

test("--wait-for-idle never interrupts, and a timeout lets everything go", async () => {
  const harness = scriptedHarness({ inFlight: () => 4 });
  const result = await fenceRuntimeAdmission(config({ waitForIdleMs: 20 * 60_000 }), harness.adapters);
  assert.equal(result.safe, false);
  assert.equal(result.reason, waitForIdleTimeoutMessage(20 * 60_000));
  assert.match(result.reason, /^Bots were still busy after 20 minutes; nothing was interrupted\.  /);
  assert.equal(harness.state.forced, 0, "never forced");
  assert.equal(harness.state.released, 1);
  assert.equal(harness.state.draining, false);
});

test("--wait-for-idle proceeds as soon as the work finishes", async () => {
  const harness = scriptedHarness({ inFlight: (t) => (t < 300_000 ? 1 : 0) });
  const result = await fenceRuntimeAdmission(config({ waitForIdleMs: 20 * 60_000 }), harness.adapters);
  assert.equal(result.safe, true);
  assert.equal(harness.state.forced, 0);
  assert.equal(harness.state.released, 0);
});

test("a forced answer lost to a slow harness is collected once the fence settles", async () => {
  const harness = scriptedHarness({ inFlight: () => 2, loseForcedAnswerUntil: DEFAULT_GRACE_MS + 20_000 });
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, true);
  assert.equal(harness.state.forced, 1, "not asked twice");
  assert.equal(harness.state.released, 0);
  // Not used while the harness was still interrupting and saving work.
  assert.ok(harness.clock() >= DEFAULT_GRACE_MS + 20_000);
});

test("--force watches a lost answer, and releases a fence that settles too late only once it has settled", async () => {
  const settles = scriptedHarness({ inFlight: () => 2, loseForcedAnswerUntil: 15_000 });
  assert.equal((await fenceRuntimeAdmission(config({ force: true }), settles.adapters)).safe, true);
  assert.equal(settles.state.released, 0);

  // Still settling when the watch gives up: the release waits for the settle
  // rather than standing the fence down under it.
  const late = scriptedHarness({ inFlight: () => 2, loseForcedAnswerUntil: 150_000 });
  const result = await fenceRuntimeAdmission(config({ force: true }), late.adapters);
  assert.equal(result.safe, false);
  assert.equal(late.state.released, 1, "never left fenced");
  assert.equal(late.state.quiescing, false);
  assert.ok(late.state.releasedAt[0] >= 150_000, `released at ${late.state.releasedAt[0]}, mid-settle`);
  assert.equal(late.state.requests.filter((line) => line.startsWith("DELETE")).length, 1);

  // One that never settles: the release is left with the harness, which
  // honours it when the settle comes, and the operator is told how to finish.
  const never = scriptedHarness({ inFlight: () => 2, loseForcedAnswerUntil: Number.MAX_SAFE_INTEGER });
  const stuck = await fenceRuntimeAdmission(config({ force: true }), never.adapters);
  assert.equal(stuck.safe, false);
  assert.match(stuck.reason, /unquiesce/);
  assert.equal(never.state.releasePending, true, "the harness holds the release for its settle");
});

test("a release never stands down a fence that is still settling", async () => {
  // Finding 1: a DELETE at the final deadline, on SIGINT, or in the --force
  // give-up used to land mid-settle.  The release now waits for `fencing` to
  // clear first, and only then asks.
  const harness = scriptedHarness({ inFlight: () => 2, loseForcedAnswerUntil: 40_000 });
  // Start the forced quiesce whose answer is lost, so the harness is settling.
  await harness.adapters.requestJson("http://127.0.0.1:8799/api/runtime/quiesce?force=true", { method: "POST" });
  await releaseRuntimeAdmission(config(), harness.adapters);
  assert.equal(harness.state.released, 1);
  assert.ok(harness.state.releasedAt[0] >= 40_000, "not before the settle");
  assert.equal(harness.state.releasePending, false);
  const deleteAt = harness.state.requests.indexOf("DELETE /api/runtime/quiesce");
  assert.ok(deleteAt > 0 && harness.state.requests.slice(1, deleteAt).every((line) => line === "GET /api/runtime"),
    "the updater only read the runtime until it settled");
});

test("the installed harness, whose forced answer was lost, is not used while it is still interrupting", async () => {
  // Finding 2: the harness on the owner's Mac (15a5097e5) raises `quiescing`
  // before it interrupts anything and never reports `fencing`.  Treating the
  // missing field as settled let an install start under a harness still
  // interrupting bots, or about to roll back.
  const settles = scriptedHarness({ drains: false, reportsFencing: false, inFlight: () => 2, loseForcedAnswerUntil: 20_000 });
  const fenced = await fenceRuntimeAdmission(config({ force: true }), settles.adapters);
  assert.equal(fenced.safe, true);
  assert.ok(settles.clock() >= 20_000, `used at ${settles.clock()}, while it still counted work`);
  assert.ok(settles.state.polls >= 3, "it was watched, not taken at the first sight of `quiescing`");
  assert.equal(settles.state.released, 0);

  // It rolls itself back instead: a refusal, never a fence.
  const rolledBack = scriptedHarness({
    drains: false, reportsFencing: false, inFlight: () => 2, loseForcedAnswerUntil: 20_000, rollsBack: true,
  });
  const refused = await fenceRuntimeAdmission(config({ force: true }), rolledBack.adapters);
  assert.equal(refused.safe, false);
  assert.equal(rolledBack.state.quiescing, false);

  // Never settles inside the watch: released (after giving it the legacy
  // settle window), never installed over.
  const busy = scriptedHarness({ drains: false, reportsFencing: false, inFlight: () => 2, loseForcedAnswerUntil: Number.MAX_SAFE_INTEGER });
  const gaveUp = await fenceRuntimeAdmission(config({ force: true }), busy.adapters);
  assert.equal(gaveUp.safe, false);
  assert.equal(busy.state.released, 1);

  // The grace mode against the same harness: a second forced ask while it
  // still interrupts answers `quiescing: true` with work counted, and is not
  // taken for a fence either.
  const graced = scriptedHarness({
    drains: false, reportsFencing: false, inFlight: () => 2, loseForcedAnswerUntil: DEFAULT_GRACE_MS + 40_000,
  });
  const afterGrace = await fenceRuntimeAdmission(config(), graced.adapters);
  assert.equal(afterGrace.safe, true);
  assert.ok(graced.clock() >= DEFAULT_GRACE_MS + 40_000);
  assert.ok(graced.state.forced >= 2, "asked again while it settled");
});

test("a lost answer to the first hold request is asked again, and released if it never comes", async () => {
  const flaky = scriptedHarness({ inFlight: () => 0, loseFirstAnswers: 2 });
  assert.equal((await fenceRuntimeAdmission(config(), flaky.adapters)).safe, true);

  const silent = scriptedHarness({ inFlight: () => 0, loseFirstAnswers: Number.MAX_SAFE_INTEGER });
  const result = await fenceRuntimeAdmission(config(), silent.adapters);
  assert.equal(result.safe, false);
  assert.match(result.reason, /could not be established/);
  assert.equal(silent.state.released, 1, "a hold that may have started is let go");
  assert.equal(silent.state.draining, false);
});

test("--force skips the hold and the grace entirely", async () => {
  const harness = scriptedHarness({ inFlight: () => 5 });
  const result = await fenceRuntimeAdmission(config({ force: true }), harness.adapters);
  assert.equal(result.safe, true);
  assert.deepEqual(harness.state.requests, ["POST /api/runtime/quiesce?force=true&leaseMs=180000"]);
});

test("a rollback takes the fence on the replacement at once: no hold, no grace, no hours of waiting", async () => {
  // Finding 4: rollback ran the whole hold, grace and pause cycle against the
  // replacement, and under --wait-for-idle could wait up to six hours.
  const busy = scriptedHarness({ inFlight: () => 3 });
  const paused = await fenceRuntimeAdmission(rollbackFenceConfig(config()), busy.adapters);
  assert.equal(paused.safe, true);
  assert.deepEqual(busy.state.requests, ["POST /api/runtime/quiesce?force=true&leaseMs=180000"]);
  assert.equal(busy.clock(), 0);

  // --wait-for-idle never interrupts, so the rollback asks once and defers.
  const patient = scriptedHarness({ inFlight: () => 3 });
  const deferred = await fenceRuntimeAdmission(rollbackFenceConfig(config({ waitForIdleMs: 6 * 60 * 60_000 })), patient.adapters);
  assert.equal(deferred.safe, false);
  assert.equal(patient.state.forced, 0);
  assert.deepEqual(patient.state.requests, ["POST /api/runtime/quiesce?leaseMs=180000"]);
  assert.equal(patient.clock(), 0);

  const idle = scriptedHarness({ inFlight: () => 0 });
  assert.equal((await fenceRuntimeAdmission(rollbackFenceConfig(config({ waitForIdleMs: 60_000 })), idle.adapters)).safe, true);
  assert.equal(fenceMode(rollbackFenceConfig({})), "force");
  assert.equal(fenceMode(rollbackFenceConfig({ waitForIdleMs: 60_000 })), "now");
});

test("a signal while holding lifts the hold before the run ends", async () => {
  const signals = new EventEmitter();
  const harness = scriptedHarness({ inFlight: () => 1 });
  const sleep = harness.adapters.sleep;
  let slept = 0;
  harness.adapters.sleep = async (ms) => {
    slept += 1;
    if (slept === 2) signals.emit("SIGTERM");
    return sleep(ms);
  };
  const result = await fenceRuntimeAdmission(config(), { ...harness.adapters, signals });
  assert.equal(result.safe, false);
  assert.match(result.reason, /Stopped by SIGTERM/);
  assert.equal(harness.state.released, 1);
  assert.equal(harness.state.forced, 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0, "listeners are removed");
});

/** Timers the lease loop schedules, fired by hand. */
function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (fn) => {
      const handle = { fn, cleared: false, unref() {} };
      pending.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (handle) handle.cleared = true;
    },
    async fire() {
      // A renewal in flight schedules the next one when it settles.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      const due = pending.splice(0).filter((handle) => !handle.cleared);
      for (const handle of due) handle.fn();
      // Let the renewal's request settle and reschedule.
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    },
  };
}

test("a signal during the checks after the fence releases it instead of leaving BotFleet fenced", async () => {
  // Finding 6: the 30-second health retry after the fence ran with no signal
  // handler, so Ctrl-C there killed the updater with the harness fenced.
  const signals = new EventEmitter();
  const harness = scriptedHarness({ inFlight: () => 0 });
  let asked = 0;
  harness.adapters.healthTopology = async () => {
    asked += 1;
    if (asked === 2) signals.emit("SIGINT");
    return { safe: false, reason: "A BotFleet port returned an unavailable or ambiguous response" };
  };
  const result = await fenceRuntimeAdmission(config(), { ...harness.adapters, signals });
  assert.equal(result.safe, false);
  assert.match(result.reason, /^Stopped by SIGINT before the update started; the fence was released/);
  assert.equal(harness.state.released, 1);
  assert.equal(harness.state.quiescing, false);
  assert.ok(harness.clock() < 30_000, "the retry was cut short");
  assert.equal(signals.listenerCount("SIGINT"), 0, "Node's default is back once the step returns");

  // The same during the database holder wait.
  const holding = scriptedHarness({ inFlight: () => 0 });
  const stays = holderTable({ 77004: { command: "sqlite3 messages.db", cwd: "/", executable: "/usr/bin/sqlite3" } });
  holding.adapters.sqliteHolders = async () => [42, 77004];
  holding.adapters.processIdentity = stays.deps;
  const sleep = holding.adapters.sleep;
  holding.adapters.sleep = async (ms) => {
    await sleep(ms);
    if (holding.clock() >= 6_000) signals.emit("SIGTERM");
  };
  const stopped = await fenceRuntimeAdmission(config(holderConfig), { ...holding.adapters, signals });
  assert.match(stopped.reason, /^Stopped by SIGTERM/);
  assert.equal(holding.state.released, 1);
  assert.ok(holding.clock() < 90_000);
  assert.deepEqual(stays.signals, []);
});

test("Ctrl-C that lands while a request is in flight is honoured even when that request fenced", async () => {
  // Finding 11: a signal during the request that then fenced was ignored, and
  // the update went ahead.
  const signals = new EventEmitter();
  const converting = scriptedHarness({
    inFlight: (t) => (t < 10_000 ? 1 : 0),
    onRequest: (method, params) => {
      if (method === "POST" && !params.get("drain") && !params.get("force")) signals.emit("SIGINT");
    },
  });
  const result = await fenceRuntimeAdmission(config(), { ...converting.adapters, signals });
  assert.equal(result.safe, false);
  assert.match(result.reason, /^Stopped by SIGINT before the update started; nothing was interrupted\./);
  assert.equal(converting.state.plain, 1, "the fence was raised");
  assert.equal(converting.state.released, 1, "and let go");
  assert.equal(converting.state.quiescing, false);

  // The forced quiesce of the grace mode, and of --force.
  for (const extra of [{}, { force: true }]) {
    const forcing = scriptedHarness({
      inFlight: () => 2,
      onRequest: (_method, params) => {
        if (params.get("force") === "true") signals.emit("SIGINT");
      },
    });
    const stopped = await fenceRuntimeAdmission(config(extra), { ...forcing.adapters, signals });
    assert.equal(stopped.safe, false);
    assert.match(stopped.reason, /^Stopped by SIGINT before the update started; .*resumed/);
    assert.equal(forcing.state.forced, 1);
    assert.equal(forcing.state.released, 1);
    assert.equal(forcing.state.quiescing, false);
    assert.equal(signals.listenerCount("SIGINT"), 0);
  }
});

test("a fence this run takes carries a lease, renewed until the run lets go or the harness is gone", async () => {
  // Finding 6: an updater killed after the fence left BotFleet fenced until
  // someone ran `unquiesce`.  The harness now releases a fence nobody renews.
  const timers = manualTimers();
  const harness = scriptedHarness({ inFlight: () => 0, leases: true });
  const result = await fenceRuntimeAdmission(config(), { ...harness.adapters, ...timers });
  assert.equal(result.safe, true);
  assert.ok(harness.state.requests.includes("POST /api/runtime/quiesce?leaseMs=180000"), "the fence asked for its lease");
  assert.ok(result.lease?.active);
  assert.equal(harness.state.renewals, 1, "renewed at once");
  await timers.fire();
  await timers.fire();
  assert.equal(harness.state.renewals, 3, "and on, past the fence step, while the harness lives");

  // A refusal after the fence stops renewing BEFORE it releases, so a renewal
  // can never land after the release.
  const refusing = scriptedHarness({ inFlight: () => 0, leases: true });
  refusing.adapters.sqliteHolders = async () => [42, 43];
  refusing.adapters.processIdentity = holderTable({ 43: { command: APP_EXECUTABLE, cwd: "/" } }).deps;
  const refusalTimers = manualTimers();
  const refused = await fenceRuntimeAdmission(config(holderConfig), { ...refusing.adapters, ...refusalTimers });
  assert.equal(refused.safe, false);
  const lastRenewal = refusing.state.requests.lastIndexOf("POST /api/runtime/quiesce?renew=1&leaseMs=180000");
  const releasedAt = refusing.state.requests.indexOf("DELETE /api/runtime/quiesce");
  assert.ok(lastRenewal >= 0 && lastRenewal < releasedAt);
  await refusalTimers.fire();
  assert.equal(refusing.state.requests.lastIndexOf("POST /api/runtime/quiesce?renew=1&leaseMs=180000"), lastRenewal,
    "no renewal after the release");

  // A harness that predates leases is never sent a renewal: it would read one
  // as a plain quiesce.
  const older = scriptedHarness({ inFlight: () => 0 });
  const olderTimers = manualTimers();
  const plain = await fenceRuntimeAdmission(config(), { ...older.adapters, ...olderTimers });
  assert.equal(plain.safe, true);
  assert.equal(plain.lease, null);
  assert.ok(!older.state.requests.some((line) => line.includes("renew")));
});

test("the lease loop stops on its own once the fence is down or the harness has changed", async () => {
  const timers = manualTimers();
  let answer = { kind: "ok", status: 200, body: { pid: 42, quiescing: true } };
  let asked = 0;
  const loop = keepFenceLease(OWNER, {
    request: async () => {
      asked += 1;
      return answer;
    },
    ...timers,
  });
  await timers.fire();
  assert.equal(asked, 2);
  assert.equal(loop.active, true);
  answer = { kind: "http", status: 401, body: null };
  await timers.fire();
  assert.equal(loop.active, false);
  await timers.fire();
  assert.equal(asked, 3, "nothing after a restarted harness refused it");

  const down = keepFenceLease(OWNER, { request: async () => ({ kind: "ok", status: 200, body: { pid: 42, quiescing: false } }), ...manualTimers() });
  await Promise.resolve();
  await down.stop();
  assert.equal(down.active, false);
});

test("a harness that stopped holding on its own ends the run without a second release", async () => {
  const harness = scriptedHarness({ inFlight: () => 1 });
  const request = harness.adapters.requestJson;
  harness.adapters.requestJson = async (url, options = {}) => {
    const answer = await request(url, options);
    if ((options.method ?? "GET") === "GET") return { ...answer, body: { ...answer.body, draining: false, drain: null } };
    return answer;
  };
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, false);
  assert.match(result.reason, /stopped holding new work/);
  assert.equal(harness.state.released, 0);
});

test("a harness that goes quiet is given a minute, then the hold is released", async () => {
  const harness = scriptedHarness({ inFlight: () => 1 });
  const request = harness.adapters.requestJson;
  harness.adapters.requestJson = async (url, options = {}) => {
    if ((options.method ?? "GET") === "GET") return { kind: "unavailable", reason: "TimeoutError" };
    return request(url, options);
  };
  const result = await fenceRuntimeAdmission(config({ waitForIdleMs: 20 * 60_000 }), harness.adapters);
  assert.equal(result.safe, false);
  assert.match(result.reason, /stopped answering/);
  assert.equal(harness.state.released, 1);
});

test("an older harness without holds still updates: an idle moment, or the grace then force", async () => {
  const idleSoon = scriptedHarness({ drains: false, inFlight: (t) => (t < 10_000 ? 2 : 0) });
  assert.equal((await fenceRuntimeAdmission(config(), idleSoon.adapters)).safe, true);
  assert.equal(idleSoon.state.forced, 0);
  assert.equal(idleSoon.state.polls, 0, "nothing is held, so nothing is polled");

  const busy = scriptedHarness({ drains: false, inFlight: () => 2 });
  assert.equal((await fenceRuntimeAdmission(config(), busy.adapters)).safe, true);
  assert.equal(busy.state.forced, 1);
  assert.equal(busy.state.released, 0, "nothing was held, so nothing is released");
});

test("a fence that fails its ownership check after the hold is still released", async () => {
  // A second holder that is BotFleet itself is a real ambiguity: refused at
  // once, not waited on.
  const harness = scriptedHarness({ inFlight: () => 0 });
  harness.adapters.sqliteHolders = async () => [42, 43];
  harness.adapters.processIdentity = holderTable({ 43: { command: APP_EXECUTABLE, cwd: "/" } }).deps;
  const result = await fenceRuntimeAdmission(config(holderConfig), harness.adapters);
  assert.equal(result.safe, false);
  assert.match(result.reason, /Database ownership is ambiguous/);
  assert.equal(harness.state.released, 1);
  assert.equal(harness.state.quiescing, false);
  assert.equal(harness.clock(), 0, "not waited on");
});

test("a foreign process holding the database after the fence is waited out, never signalled", async () => {
  // Finding 5: the 90-second wait covered capture and quiesce, but not the two
  // places such a process actually trips an update.
  const harness = scriptedHarness({ inFlight: () => 0 });
  const { table, signals, deps } = holderTable({
    77001: { command: "sqlite3 /Users/test/.botfleet/messages.db", cwd: "/", executable: "/usr/bin/sqlite3" },
  });
  harness.adapters.sqliteHolders = async () => [42, ...[...table].filter(([, row]) => row.alive).map(([pid]) => pid)];
  harness.adapters.processIdentity = deps;
  const sleep = harness.adapters.sleep;
  harness.adapters.sleep = async (ms) => {
    await sleep(ms);
    if (harness.clock() >= 8_000) table.get(77001).alive = false;
  };
  const result = await fenceRuntimeAdmission(config(holderConfig), harness.adapters);
  assert.equal(result.safe, true);
  assert.deepEqual(result.holders, [42]);
  assert.ok(harness.clock() >= 8_000);
  assert.deepEqual(signals, []);
  assert.ok(harness.state.reports.includes("Waiting for sqlite3 to let go of BotFleet's files"));

  // One that stays is named, never signalled, and the fence is released.
  const stuck = scriptedHarness({ inFlight: () => 0 });
  const stays = holderTable({ 77002: { command: "node /tmp/probe.js", cwd: "/tmp", executable: "/opt/homebrew/bin/node" } });
  stuck.adapters.sqliteHolders = async () => [42, 77002];
  stuck.adapters.processIdentity = stays.deps;
  const refused = await fenceRuntimeAdmission(config(holderConfig), stuck.adapters);
  assert.equal(refused.safe, false);
  assert.match(refused.reason, /^Process 77002 still holds BotFleet state after 1\.5 minutes and is not a BotFleet process/);
  assert.match(refused.reason, /\/opt\/homebrew\/bin\/node/);
  assert.equal(stuck.state.released, 1);
  assert.deepEqual(stays.signals, []);
});

test("preflight waits out a foreign database holder the same way, and names one that stays", async () => {
  const { table, signals, deps } = holderTable({
    77003: { command: "curl http://127.0.0.1:8799/api/health", cwd: "/", executable: "/usr/bin/curl" },
  });
  let clock = 0;
  const holders = async () => [42, ...[...table].filter(([, row]) => row.alive).map(([pid]) => pid)];
  const waited = await settledDatabaseHolders({ ...holderConfig, dataDirectory: "/private/data" }, 42, {
    inspect: holders,
    identify: deps,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
      if (clock >= 4_000) table.get(77003).alive = false;
    },
  });
  assert.deepEqual(waited, { holders: [42] });
  assert.deepEqual(signals, []);

  clock = 0;
  table.get(77003).alive = true;
  const named = await settledDatabaseHolders({ ...holderConfig, dataDirectory: "/private/data", unknownHolderWaitMs: 30_000 }, 42, {
    inspect: holders,
    identify: deps,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(named.holders, null);
  assert.match(named.reason, /Process 77003 still holds BotFleet state after 30 seconds/);
  assert.match(named.reason, /\(\/usr\/bin\/curl\)$/);
  assert.equal(clock, 30_000);
  assert.deepEqual(signals, []);
});

test("a slow health port after the fence is asked again rather than failing the update", async () => {
  const harness = scriptedHarness({ inFlight: () => 0 });
  let asked = 0;
  harness.adapters.healthTopology = async () => {
    asked += 1;
    return asked < 3
      ? { safe: false, reason: "A BotFleet port returned an unavailable or ambiguous response" }
      : { safe: true, pid: 42, pids: [42], port: 8799, health: [] };
  };
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, true);
  assert.equal(asked, 3);
});

test("preflight asks a slow harness again inside a bounded window", async () => {
  let clock = 0;
  const adapters = { now: () => clock, sleep: async (ms) => { clock += ms; } };
  let calls = 0;
  const slowThenFine = await runtimePreflight({ dataDirectory: "/private/data" }, null, {
    ...adapters,
    strictPreflight: async () => {
      calls += 1;
      return calls < 3
        ? { safe: false, transient: true, reason: "Authenticated runtime readiness could not be verified" }
        : { safe: true, mode: "authenticated" };
    },
  });
  assert.equal(slowThenFine.safe, true);
  assert.equal(calls, 3);

  // A definitive answer is not retried.
  calls = 0;
  const wrong = await runtimePreflight({ dataDirectory: "/private/data" }, null, {
    ...adapters,
    strictPreflight: async () => {
      calls += 1;
      return { safe: false, reason: "Authenticated runtime identity does not match the data owner" };
    },
  });
  assert.equal(wrong.safe, false);
  assert.equal(calls, 1);

  // A harness that never answers fails once the window is spent.
  clock = 0;
  calls = 0;
  const silent = await runtimePreflight({ dataDirectory: "/private/data", preflightRetryMs: 20_000 }, null, {
    ...adapters,
    strictPreflight: async () => {
      calls += 1;
      return { safe: false, transient: true, reason: "Authenticated runtime readiness could not be verified" };
    },
  });
  assert.equal(silent.safe, false);
  assert.match(silent.reason, /could not be verified/);
  assert.equal(clock, 20_000);
  assert.ok(calls >= 3 && calls <= 6, `asked ${calls} times`);

  // Preflight never refuses for work in flight any more.
  const busy = await runtimePreflight({ dataDirectory: "/private/data" }, null, {
    ...adapters,
    strictPreflight: async (_config, _build, { requireIdle }) => {
      assert.equal(requireIdle, false);
      return { safe: true };
    },
  });
  assert.equal(busy.safe, true);
});

test("retryTransient backs off and stops at the window", async () => {
  let clock = 0;
  const waits = [];
  await retryTransient(async () => ({ transient: true }), {
    windowMs: 30_000,
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 10_000, 5_000]);
});

test("the mode flags parse, and contradictory ones are refused", () => {
  assert.equal(parseArguments(["apply", "--stage", "/tmp/s", "--grace", "90"]).graceMs, 90_000);
  assert.equal(parseArguments(["update", "--grace=0"]).graceMs, 0);
  assert.equal(parseArguments(["update", "--wait-for-idle"]).waitForIdleMs, 20 * 60_000);
  assert.equal(parseArguments(["update", "--wait-for-idle", "45"]).waitForIdleMs, 45 * 60_000);
  assert.equal(parseArguments(["update", "--wait-for-idle=5"]).waitForIdleMs, 5 * 60_000);
  // A bare flag followed by another flag does not swallow it.
  const parsed = parseArguments(["update", "--wait-for-idle", "--no-open"]);
  assert.equal(parsed.waitForIdleMs, 20 * 60_000);
  assert.equal(parsed.openApplication, false);
  assert.throws(() => parseArguments(["update", "--grace", "-1"]), /--grace/);
  assert.throws(() => parseArguments(["update", "--grace", "601"]), /--grace/);
  assert.throws(() => parseArguments(["update", "--wait-for-idle=0"]), /--wait-for-idle/);
  assert.throws(() => parseArguments(["update", "--force", "--wait-for-idle"]), /opposite/);
  assert.throws(() => parseArguments(["unquiesce", "--grace", "5"]), /accepts no options/);

  assert.equal(fenceMode({}), "grace");
  assert.equal(fenceMode({ waitForIdleMs: 60_000 }), "wait-for-idle");
  assert.equal(fenceMode({ force: true }), "force");
});

// The wrapper is a macOS bash script; Windows has no /bin/bash to run it with.
test("the wrapper's up-to-date shortcut survives the busy-work flags and nothing else new", { skip: process.platform === "win32" }, async () => {
  // Just the argument loop, lifted out of the wrapper: the full wrapper test
  // needs a real checkout at origin/main, which a linked worktree is not.
  const wrapper = await readFile(join(dirname(fileURLToPath(import.meta.url)), "update-botfleet.sh"), "utf8");
  const start = wrapper.indexOf("SHORTCUT_ARG_INDEX=0");
  const endMarker = '[[ "$EXPECT_SHORTCUT_TARGET" == "0" ]] || UP_TO_DATE_SHORTCUT=0';
  const end = wrapper.indexOf(endMarker) + endMarker.length;
  assert.ok(start > 0 && end > start, "the shortcut loop is where this test expects it");
  const loop = `UP_TO_DATE_SHORTCUT=1\n${wrapper.slice(start, end)}\necho "$UP_TO_DATE_SHORTCUT"`;
  const shortcut = (args) => {
    const result = spawnSync("/bin/bash", ["-c", loop, "wrapper", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() === "1";
  };
  for (const args of [[], ["update"], ["--grace", "90"], ["--grace=5"], ["--wait-for-idle"], ["--wait-for-idle", "30"],
    ["--wait-for-idle=10", "--no-open"], ["update", "--wait-for-idle", "--grace", "0"], ["--force"]]) {
    assert.equal(shortcut(args), true, `${JSON.stringify(args)} keeps the shortcut`);
  }
  for (const args of [["apply"], ["--grace", "90", "stray"], ["--wait-for-idle", "soon"], ["--progress", "/tmp/p"], ["--target", "abc"]]) {
    assert.equal(shortcut(args), false, `${JSON.stringify(args)} reaches the updater`);
  }
});

// ── a process that is not BotFleet holding BotFleet state ───────────────────
// 2026-10-08, 9:08pm: `apply --force` refused on "Process 59135 owns BotFleet
// state but does not match an expected BotFleet executable", and the process
// was gone seconds later — a bot's own sqlite3, node or curl.

const holderConfig = {
  appPath: "/Applications/BotFleet.app",
  checkout: "/Users/test/apps/botfleet-server",
  gracefulExitMs: 0,
  termExitMs: 0,
};
const APP_EXECUTABLE = "/Applications/BotFleet.app/Contents/MacOS/BotFleet";

/** A process table a test changes as time passes, with every signal recorded. */
function holderTable(rows) {
  const table = new Map(Object.entries(rows).map(([pid, row]) => [Number(pid), { alive: true, ...row }]));
  const signals = [];
  return {
    table,
    signals,
    deps: {
      isAlive: async (pid) => table.get(pid)?.alive === true,
      commandOf: async (pid) => (table.get(pid)?.alive ? table.get(pid).command : ""),
      cwdOf: async (pid) => (table.get(pid)?.alive ? table.get(pid).cwd : ""),
      executableOf: async (pid) => (table.get(pid)?.alive ? table.get(pid).executable ?? "" : ""),
      // What the process has mapped: nothing BotFleet, unless the row says so.
      txtPathsOf: async (pid) => (table.get(pid)?.alive ? table.get(pid).txt ?? [] : []),
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        const row = table.get(pid);
        if (row) row.alive = false;
      },
    },
  };
}

test("a holder that lets go inside the window is waited out, re-resolved, and never signalled", async () => {
  const { table, signals, deps } = holderTable({
    59135: { command: "sqlite3 /Users/test/.botfleet/botfleet.sqlite", cwd: "/", executable: "/usr/bin/sqlite3" },
    501: { command: APP_EXECUTABLE, cwd: "/" },
  });
  let clock = 0;
  let passes = 0;
  const reports = [];
  const captured = await waitOutUnrecognizedHolders(async () => {
    passes += 1;
    // What holds BotFleet state is resolved again on every pass.
    const holders = [...table.entries()].filter(([, row]) => row.alive).map(([pid]) => pid);
    return captureProcessIdentities(holders, holderConfig, deps);
  }, {
    windowMs: 90_000,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
      if (clock >= 6_000) table.get(59135).alive = false;
    },
    report: (line) => reports.push(line),
  });
  assert.deepEqual(captured.pids, [501]);
  assert.equal(passes, 4);
  assert.deepEqual(reports, ["Waiting for sqlite3 to let go of BotFleet's files"]);
  assert.deepEqual(signals, [], "nothing was signalled");
});

test("a holder still there when the window closes is refused by its executable, still unsignalled", async () => {
  const { signals, deps } = holderTable({
    59135: { command: "node /tmp/probe.js", cwd: "/tmp", executable: "/opt/homebrew/bin/node" },
  });
  let clock = 0;
  await assert.rejects(
    waitOutUnrecognizedHolders(() => captureProcessIdentities([59135], holderConfig, deps), {
      windowMs: 90_000,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
    }),
    (error) => {
      assert.equal(error.name, "UnrecognizedHolderError");
      assert.equal(error.pid, 59135);
      assert.equal(error.executable, "/opt/homebrew/bin/node");
      assert.match(error.message, /^Process 59135 still holds BotFleet state after 1\.5 minutes and is not a BotFleet process/);
      assert.match(error.message, /\(\/opt\/homebrew\/bin\/node\)$/);
      assert.match(error.message, /will not stop it\.  Quit it/);
      return true;
    },
  );
  assert.equal(clock, 90_000);
  assert.deepEqual(signals, []);
});

test("other failures are not waited on", async () => {
  let passes = 0;
  await assert.rejects(
    waitOutUnrecognizedHolders(async () => {
      passes += 1;
      throw new Error("Database ownership is ambiguous");
    }, { windowMs: 90_000, now: () => 0, wait: async () => {} }),
    /Database ownership is ambiguous/,
  );
  assert.equal(passes, 1);
});

test("quiesce identifies every survivor before signalling any, so a foreign holder stops nothing halfway", async () => {
  const { signals, deps } = holderTable({
    501: { command: APP_EXECUTABLE, cwd: "/" },
    59135: { command: "curl http://127.0.0.1:8799/api/health", cwd: "/", executable: "/usr/bin/curl" },
  });
  const previous = { runtimePids: [], appPids: [501], processCommands: { 501: APP_EXECUTABLE }, processCwds: { 501: "/" } };
  await assert.rejects(
    terminateVerified([501, 59135], previous, holderConfig, { current: [501, 59135], ...deps }),
    (error) => error instanceof UnrecognizedHolderError && error.executable === "/usr/bin/curl",
  );
  assert.deepEqual(signals, [], "the BotFleet process was not stopped ahead of the refusal");
  // Once the foreign process lets go, the next pass stops BotFleet alone.
  deps.isAlive = async (pid) => pid === 501 && !signals.length;
  await terminateVerified([501], previous, holderConfig, { current: [501], ...deps });
  assert.deepEqual(signals, [[501, "SIGTERM"]]);
});

test("progress sentences name what the update is waiting for, in a person's words", () => {
  assert.equal(drainProgressDetail({ drain: { bots: 1, inFlight: 1, rooms: 0 } }), "Waiting for 1 bot to finish");
  assert.equal(drainProgressDetail({ drain: { bots: 0, inFlight: 2, rooms: 0 } }), "Waiting for 2 operations to finish");
  assert.equal(drainProgressDetail({ activeWorkCount: 7 }), "Waiting for 7 operations to finish");
  assert.equal(drainProgressDetail({ drain: { bots: 3, inFlight: 3, rooms: 0 } }, "pause"), "Pausing 3 bots to resume after the update");
  assert.equal(drainProgressDetail({ drain: { bots: 2, inFlight: 2, rooms: 2 } }, "pause"), "Waiting for 2 room conversations to finish");
  for (const text of [
    waitForIdleTimeoutMessage(20 * 60_000),
    pauseTimeoutMessage(6 * 60_000, { drain: { rooms: 1 } }),
    pauseTimeoutMessage(6 * 60_000, { drain: { rooms: 0 } }),
  ]) {
    assert.doesNotMatch(text, /agent/i);
    // Two spaces between sentences in everything a person reads.
    assert.doesNotMatch(text, /[a-z]\. [A-Z]/);
  }
  assert.equal(describeWindow(60_000), "1 minute");
  assert.equal(describeWindow(90_000), "1.5 minutes");
  assert.equal(describeWindow(45_000), "45 seconds");
});

// ── 2026-10-09 overnight: slow exits, deferred rollbacks, BotFleet left stopped ──

test("a BotFleet process slow to quit is waited for, nudged once, and never killed", async () => {
  // "BotFleet process 11736 still runs from inside /Applications/BotFleet.app
  // after graceful shutdown", at a load average of 50 to 500 per core.
  let clock = 0;
  const reports = [];
  const nudges = [];
  await waitForBotFleetExit(async () => (clock < 75_000
    ? { reason: "BotFleet process 11736 still runs from inside /Applications/BotFleet.app after graceful shutdown", pids: [11736] }
    : null), {
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    report: (line) => reports.push(line),
    nudge: async ({ pids }) => { nudges.push([clock, ...pids]); },
  });
  assert.ok(clock >= 75_000 && clock < DEFAULT_EXIT_WAIT_MS);
  assert.equal(nudges.length, 1, "one verified SIGTERM, never a second signal");
  assert.ok(nudges[0][0] >= 20_000);
  assert.deepEqual(reports, ["Waiting for BotFleet to finish quitting (1 process)"]);

  // One that never quits ends the wait, bounded, with what was still there.
  clock = 0;
  await assert.rejects(waitForBotFleetExit(async () => ({ reason: "BotFleet process 11736 still runs", pids: [11736] }), {
    now: () => clock,
    wait: async (ms) => { clock += ms; },
  }), /^Error: BotFleet process 11736 still runs \(waited 3 minutes for it to quit; never SIGKILL\)$/);
  assert.equal(clock, DEFAULT_EXIT_WAIT_MS);
});

test("a rollback is deferred only when a live harness refuses; processes on their way out are waited out", () => {
  // The overnight deferral had no harness answering at all: nothing owned
  // active work, and deferring left BotFleet stopped.
  assert.equal(rollbackReadinessError(4, { safe: false, reason: "Runtime admission fence could not be established" }, { harnessAnswers: false }), null);
  assert.equal(rollbackReadinessError(4, { safe: false, reason: "A room conversation is live" }, { harnessAnswers: true }), "A room conversation is live");
  assert.equal(rollbackReadinessError(0, { safe: false, reason: "x" }, { harnessAnswers: true }), null);
});

test("BotFleet is started again when no harness answers, after an instance still quitting has gone", async () => {
  let clock = 0;
  let running = false;
  let quitting = [11736];
  const started = [];
  const result = await ensureBotFleetRunning({
    answers: async () => running,
    bundleBusy: async () => quitting,
    start: async (how) => {
      started.push(how);
      running = true;
    },
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
      if (clock >= 10_000) quitting = [];
    },
  });
  assert.deepEqual(result, { started: true, mixed: null });
  assert.deepEqual(started, [{ appStillQuitting: false }], "started once, after the quitting instance had gone");
  assert.ok(clock >= 10_000);

  // Already running: nothing is started, so a live replacement never gets a second harness.
  let starts = 0;
  assert.deepEqual(await ensureBotFleetRunning({ answers: async () => true, start: async () => { starts += 1; } }), { started: false });
  assert.equal(starts, 0);

  // A checkout and an app that do not match are started anyway, and said.
  const mixed = await ensureBotFleetRunning({
    answers: (() => { let n = 0; return async () => (n += 1) > 1; })(),
    mismatch: async () => "the checkout is at aaaaaaaaaaaa but /Applications/BotFleet.app was built from bbbbbbbbbbbb",
    start: async () => {},
    now: () => clock,
    wait: async (ms) => { clock += ms; },
  });
  assert.equal(mixed.started, true);
  assert.match(mixed.mixed, /checkout is at aaaaaaaaaaaa/);

  // One that never answers is reported, bounded.
  clock = 0;
  await assert.rejects(ensureBotFleetRunning({
    answers: async () => false,
    start: async () => {},
    timeoutMs: 90_000,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
  }), /BotFleet was not running and did not answer within 1\.5 minutes of being started/);
});
