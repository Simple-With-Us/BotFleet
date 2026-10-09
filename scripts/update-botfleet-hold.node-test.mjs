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
  DEFAULT_GRACE_MS,
  DEFAULT_ROOM_WAIT_MS,
  describeWindow,
  drainProgressDetail,
  fenceMode,
  fenceRuntimeAdmission,
  parseArguments,
  pauseTimeoutMessage,
  retryTransient,
  runtimePreflight,
  waitForIdleTimeoutMessage,
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
  inFlight = () => 0,
  rooms = () => 0,
  bots,
  forceRefusals = 0,
  // A forced answer that times out on the updater's side while the harness
  // carries on, still `fencing` until the clock reaches this.
  loseForcedAnswerUntil,
  // The first hold request's answer is lost this many times.
  loseFirstAnswers = 0,
} = {}) {
  let clock = 0;
  let firstAnswersLost = 0;
  let fencingUntil = null;
  const state = { draining: false, quiescing: false, released: 0, forced: 0, plain: 0, polls: 0, requests: [] };
  const drain = () => ({
    inFlight: inFlight(clock),
    bots: bots ? bots(clock) : inFlight(clock),
    rooms: rooms(clock),
    held: { routineRuns: 0, sends: 0 },
  });
  const body = (extra = {}) => ({
    ...IDENTITY,
    safeToRestart: inFlight(clock) === 0,
    activeWorkCount: inFlight(clock),
    quiescing: state.quiescing,
    fencing: fencingUntil !== null && clock < fencingUntil,
    ...(drains ? { draining: state.draining, drain: state.draining ? drain() : null } : {}),
    ...extra,
  });
  let refusalsLeft = forceRefusals;
  const requestJson = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const { pathname, searchParams } = new URL(url);
    state.requests.push(`${method} ${pathname}${searchParams.size ? `?${searchParams}` : ""}`);
    if (method === "GET" && pathname === "/api/runtime") {
      state.polls += 1;
      return { kind: "ok", status: 200, body: body() };
    }
    if (method === "DELETE") {
      state.released += 1;
      state.draining = false;
      state.quiescing = false;
      return { kind: "ok", status: 200, body: body() };
    }
    const force = searchParams.get("force") === "true";
    if (force && loseForcedAnswerUntil !== undefined && fencingUntil === null) {
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
      state.draining = false;
      return { kind: "ok", status: 200, body: body({ safeToRestart: true, activeWorkCount: 0 }) };
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
      state.draining = false;
      return { kind: "ok", status: 200, body: body({ safeToRestart: true, activeWorkCount: 0 }) };
    }
    return { kind: "ok", status: 409, body: body() };
  };
  const adapters = {
    readOwner: async () => OWNER,
    requestJson,
    healthTopology: async () => ({ safe: true, pid: 42, pids: [42], port: 8799, health: [] }),
    sqliteHolders: async () => [42],
    releaseRuntimeAdmission: async () => {
      await requestJson(`http://127.0.0.1:8799/api/runtime/quiesce`, { method: "DELETE" });
    },
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

test("--force watches a lost answer, and releases a fence that never settles", async () => {
  const settles = scriptedHarness({ inFlight: () => 2, loseForcedAnswerUntil: 15_000 });
  assert.equal((await fenceRuntimeAdmission(config({ force: true }), settles.adapters)).safe, true);
  assert.equal(settles.state.released, 0);

  const never = scriptedHarness({ inFlight: () => 2, loseForcedAnswerUntil: Number.MAX_SAFE_INTEGER });
  const result = await fenceRuntimeAdmission(config({ force: true }), never.adapters);
  assert.equal(result.safe, false);
  assert.equal(never.state.released, 1, "never left fenced");
  assert.equal(never.state.quiescing, false);
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
  assert.deepEqual(harness.state.requests, ["POST /api/runtime/quiesce?force=true"]);
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
  const harness = scriptedHarness({ inFlight: () => 0 });
  harness.adapters.sqliteHolders = async () => [42, 43];
  const result = await fenceRuntimeAdmission(config(), harness.adapters);
  assert.equal(result.safe, false);
  assert.match(result.reason, /Database ownership is ambiguous/);
  assert.equal(harness.state.released, 1);
  assert.equal(harness.state.quiescing, false);
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

test("the wrapper's up-to-date shortcut survives the busy-work flags and nothing else new", async () => {
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
