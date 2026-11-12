import assert from "node:assert/strict";
import test from "node:test";

import { pollServerIdentity } from "./server-boot-probe.mjs";

const OUR_BODY = () => ({ app: "botfleet", pid: 4242, static: true });

function okFetch({ body = OUR_BODY(), status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

test("returns ready when our own child answers with its identity", async () => {
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "ready");
});

test("a never-completing /api/health cannot wedge the launcher past the boot budget", async () => {
  // Hangs until the probe aborts it, exactly like a server that accepts the
  // connection but never writes a response.
  const hangUntilAborted = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
    });
  const startedAt = Date.now();
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 300,
    fetchImpl: hangUntilAborted,
  });
  assert.equal(outcome.outcome, "timeout");
  assert.ok(Date.now() - startedAt < 5_000, "must bail out well before an unbounded wait");
});

test("a non-2xx health response is a foreign owner, reported without waiting out the budget", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return { ok: false, status: 503, json: async () => null };
  };
  const startedAt = Date.now();
  const outcome = await pollServerIdentity({
    port: 18799,
    pid: () => 4242,
    bootTimeoutMs: 60_000,
    fetchImpl,
  });
  assert.equal(outcome.outcome, "foreign-owner");
  assert.equal(attempts, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a non-JSON body on an HTTP response counts as a foreign owner too", async () => {
  const outcome = await pollServerIdentity({
    port: 28799,
    pid: () => 4242,
    bootTimeoutMs: 60_000,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => "not json-shaped" }),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});

test("an incomplete response body that reaches the deadline is a timeout", async () => {
  let atDeadline = false;
  const outcome = await pollServerIdentity({
    port: 28799,
    pid: () => 4242,
    bootTimeoutMs: 1_000,
    now: () => (atDeadline ? 1_000 : 0),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        atDeadline = true;
        throw new DOMException("body aborted", "AbortError");
      },
    }),
  });
  assert.equal(outcome.outcome, "timeout");
});

test("an identity mismatch (same payload shape, wrong pid) stays foreign", async () => {
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch({ body: { app: "botfleet", pid: 999, static: true } }),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});

test("a response that lands after the deadline never returns ready", async () => {
  // The clock crosses the budget while the matching response is in flight.
  let reads = 0;
  const now = () => [0, 0, 1_001][Math.min(reads++, 2)];
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 1_000,
    now,
    sleep: async () => {},
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "timeout");
});

test("connection failures keep retrying until the budget runs out", async () => {
  let attempts = 0;
  const refused = async () => {
    attempts += 1;
    throw new Error("ECONNREFUSED");
  };
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 1_500,
    fetchImpl: refused,
    sleep: async () => {},
  });
  assert.equal(outcome.outcome, "timeout");
  assert.ok(attempts >= 2, `expected several polls, saw ${attempts}`);
});

test("reports exit instead of polling after the child has died", async () => {
  let attempts = 0;
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 5_000,
    isExited: () => true,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("should not be reached");
    },
  });
  assert.equal(outcome.outcome, "exited");
  assert.equal(attempts, 0);
});

test("regression: a pid read before the spawn event must not doom our own child", async () => {
  // Mirrors the packaged-app smoke failure: Electron's utilityProcess assigns
  // proc.pid on the async `spawn` event, so a value captured at fork() time is
  // undefined while the child is already binding its port. The first probe is
  // refused (still booting), the second gets our child's real identity — and
  // the pid getter now reports the spawned pid. A pid *value* captured at
  // fork time turned this exact sequence into "foreign-owner" + a reaped
  // healthy child.
  let spawned = false;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({ app: "botfleet", pid: 4242, static: true }) };
  };
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => (spawned ? 4242 : undefined),
    bootTimeoutMs: 5_000,
    sleep: async () => {
      spawned = true; // the spawn event lands while we back off between polls
    },
    fetchImpl,
  });
  assert.equal(outcome.outcome, "ready");
  assert.equal(calls, 2);
});

test("an answer that arrives while the pid is still unknown is a foreign owner", async () => {
  // A child that has not spawned yet cannot be listening; if somebody
  // answers anyway, it is genuinely not ours.
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => undefined,
    bootTimeoutMs: 5_000,
    fetchImpl: okFetch(),
  });
  assert.equal(outcome.outcome, "foreign-owner");
});

// ---------------------------------------------------------------------------
// probeHarness + resolvePackagedServer (attach-or-spawn)

import { probeHarness, resolvePackagedServer } from "./server-boot-probe.mjs";

const HARNESS = { app: "botfleet", pid: 82972, static: false };

test("probeHarness: a BotFleet health answer identifies a harness", async () => {
  const seen = await probeHarness({
    port: 8799,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => HARNESS }),
  });
  assert.deepEqual(seen, { kind: "botfleet", pid: 82972, static: false });
});

test("probeHarness: connection refused means nobody is home", async () => {
  const seen = await probeHarness({
    port: 8799,
    fetchImpl: async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    },
  });
  assert.deepEqual(seen, { kind: "none" });
});

test("probeHarness: any other answer on the port is a foreign owner", async () => {
  for (const reply of [
    { ok: false, status: 404, json: async () => ({ error: "nope" }) },
    { ok: true, status: 200, json: async () => "text" },
    { ok: true, status: 200, json: async () => ({ app: "something-else", pid: 1 }) },
    { ok: true, status: 200, json: async () => ({ app: "botfleet" }) },
  ]) {
    const seen = await probeHarness({ port: 8799, fetchImpl: async () => reply });
    assert.equal(seen.kind, "foreign", JSON.stringify(await reply.json()));
  }
});

const noSleep = async () => {};

test("attaches to an existing BotFleet harness on 8799 and never spawns", async () => {
  let spawned = 0;
  const result = await resolvePackagedServer({
    ports: [8799, 18799, 28799],
    probe: async (port) => (port === 8799 ? { kind: "botfleet", pid: 82972, static: false } : { kind: "none" }),
    spawn: async () => {
      spawned += 1;
      return { proc: {} };
    },
    sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "attached", port: 8799, pid: 82972, static: false });
  assert.equal(spawned, 0, "must not fork a second harness against the same data dir");
});

test("spawns our own child when nothing BotFleet-shaped is listening", async () => {
  const proc = { pid: 4242 };
  const spawnedOn = [];
  const result = await resolvePackagedServer({
    ports: [8799, 18799, 28799],
    probe: async () => ({ kind: "none" }),
    spawn: async (port) => {
      spawnedOn.push(port);
      return { proc };
    },
    sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "spawned", port: 8799, proc });
  assert.deepEqual(spawnedOn, [8799]);
});

test("a foreign owner on 8799 is skipped; a harness on 18799 is attached", async () => {
  let spawned = 0;
  const result = await resolvePackagedServer({
    ports: [8799, 18799, 28799],
    probe: async (port) => {
      if (port === 8799) return { kind: "foreign" };
      if (port === 18799) return { kind: "botfleet", pid: 7, static: true };
      return { kind: "none" };
    },
    spawn: async () => {
      spawned += 1;
      return { proc: {} };
    },
    sleep: noSleep,
  });
  assert.equal(result.mode, "attached");
  assert.equal(result.port, 18799);
  assert.equal(result.static, true);
  assert.equal(spawned, 0);
});

test("a foreign owner on 8799 with nothing else listening spawns on 18799", async () => {
  const spawnedOn = [];
  const result = await resolvePackagedServer({
    ports: [8799, 18799, 28799],
    probe: async (port) => (port === 8799 ? { kind: "foreign" } : { kind: "none" }),
    spawn: async (port) => {
      spawnedOn.push(port);
      return { proc: {} };
    },
    sleep: noSleep,
  });
  assert.equal(result.mode, "spawned");
  assert.equal(result.port, 18799);
  assert.deepEqual(spawnedOn, [18799]);
});

test("a harness that vanishes during the settle window frees the port for our own child", async () => {
  // quit-and-reopen: the previous instance's child still answers the first
  // probe, then finishes dying.
  let probes = 0;
  const spawnedOn = [];
  const result = await resolvePackagedServer({
    ports: [8799],
    probe: async () => {
      probes += 1;
      return probes === 1 ? { kind: "botfleet", pid: 1, static: true } : { kind: "none" };
    },
    spawn: async (port) => {
      spawnedOn.push(port);
      return { proc: {} };
    },
    sleep: noSleep,
  });
  assert.equal(result.mode, "spawned");
  assert.deepEqual(spawnedOn, [8799]);
  assert.equal(probes, 2, "the settle re-probe must run before trusting an existing harness");
});

test("a harness that restarts during the settle window (new pid) is still attached", async () => {
  let probes = 0;
  const logs = [];
  const result = await resolvePackagedServer({
    ports: [8799],
    probe: async () => {
      probes += 1;
      return { kind: "botfleet", pid: probes === 1 ? 1 : 2, static: false };
    },
    spawn: async () => ({ proc: {} }),
    sleep: noSleep,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(result, { mode: "attached", port: 8799, pid: 2, static: false });
  assert.ok(logs.some((line) => /restarted during settle/.test(line)));
});

test("attachSettleMs: 0 attaches on the first probe", async () => {
  let probes = 0;
  const result = await resolvePackagedServer({
    ports: [8799],
    probe: async () => {
      probes += 1;
      return { kind: "botfleet", pid: 9, static: false };
    },
    spawn: async () => ({ proc: {} }),
    attachSettleMs: 0,
    sleep: noSleep,
  });
  assert.equal(result.mode, "attached");
  assert.equal(probes, 1);
});

test("every port foreign-owned reports a conflict; a child that died does not", async () => {
  const allForeign = await resolvePackagedServer({
    ports: [8799, 18799],
    probe: async () => ({ kind: "foreign" }),
    spawn: async () => {
      throw new Error("must not spawn on a foreign-owned port");
    },
    sleep: noSleep,
  });
  assert.deepEqual(allForeign, { mode: "failed", conflictOnly: true });

  const childDied = await resolvePackagedServer({
    ports: [8799, 18799],
    probe: async () => ({ kind: "none" }),
    spawn: async () => ({ proc: null, reason: "exited" }),
    sleep: noSleep,
  });
  assert.deepEqual(childDied, { mode: "failed", conflictOnly: false });
});

test("the second pass re-probes, so a harness that came up meanwhile is attached", async () => {
  // pass 1: nothing listens but our child dies (e.g. lost a bind race);
  // pass 2: whoever won the race is a BotFleet harness — join it.
  let pass = 0;
  const result = await resolvePackagedServer({
    ports: [8799],
    probe: async () => (pass === 0 ? { kind: "none" } : { kind: "botfleet", pid: 55, static: false }),
    spawn: async () => {
      pass += 1;
      return { proc: null, reason: "exited" };
    },
    attachSettleMs: 0,
    sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "attached", port: 8799, pid: 55, static: false });
});

test("ambiguous probe errors never mean a free port", async () => {
  for (const error of [new DOMException("slow", "TimeoutError"), Object.assign(new Error("reset"), { cause: { code: "ECONNRESET" } })]) {
    assert.deepEqual(await probeHarness({ port: 8799, fetchImpl: async () => { throw error; } }), { kind: "unavailable" });
  }
  assert.deepEqual(await probeHarness({ port: 8799, fetchImpl: async () => ({ json: async () => { throw new Error("aborted body"); } }) }), { kind: "unavailable" });
});

test("an uncertain listener prevents spawning on every fallback port", async () => {
  const result = await resolvePackagedServer({
    ports: [8799, 18799],
    probe: async (port) => ({ kind: port === 8799 ? "unavailable" : "none" }),
    spawn: async () => { throw new Error("duplicate spawn"); },
    sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "failed", conflictOnly: false });
});

test("a free first port does not hide an existing harness on a later port", async () => {
  const result = await resolvePackagedServer({
    ports: [8799, 18799],
    probe: async (port) => port === 18799 ? { kind: "botfleet", pid: 12, static: false } : { kind: "none" },
    spawn: async () => { throw new Error("duplicate spawn"); },
    sleep: noSleep,
  });
  assert.equal(result.mode, "attached");
  assert.equal(result.port, 18799);
});

test("a live data owner pins discovery even while its health port is not listening", async () => {
  const ports = [];
  const result = await resolvePackagedServer({
    ports: [8799, 18799], owner: () => ({ pid: 12, port: 37999 }),
    probe: async (port) => { ports.push(port); return { kind: "none" }; },
    spawn: async () => { throw new Error("duplicate spawn"); }, sleep: noSleep,
  });
  assert.deepEqual(ports, [37999, 37999]);
  assert.deepEqual(result, { mode: "failed", conflictOnly: false, unresponsiveOwner: { pid: 12, port: 37999 } });
});

test("ownership challenge rejects a matching PID without proof of the data root", async () => {
  const owner = { pid: 82972, port: 8799, nonce: "a".repeat(64) };
  assert.deepEqual(await probeHarness({ port: 8799, owner,
    fetchImpl: async () => ({ ok: true, json: async () => HARNESS }),
  }), { kind: "unavailable" });
  const { harnessOwnerProof } = await import("./harness-ownership.mjs");
  assert.deepEqual(await probeHarness({ port: 8799, owner,
    fetchImpl: async (_url, options) => ({ ok: true, json: async () => ({ ...HARNESS,
      ownerProof: harnessOwnerProof(owner, options.headers["x-botfleet-owner-challenge"]),
    }) }),
  }), { kind: "botfleet", pid: 82972, static: false });
});

test("production discovery refuses legacy or wrong-root harnesses without ownership proof", async () => {
  const result = await resolvePackagedServer({
    ports: [8799, 18799], owner: () => null,
    probe: async () => ({ kind: "botfleet", pid: 12, static: true }),
    spawn: async () => { throw new Error("duplicate spawn"); }, sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "failed", conflictOnly: false });
});

test("a live data owner that never answers is named in the failure and logged, and nothing is spawned", async () => {
  const lines = [];
  const result = await resolvePackagedServer({
    ports: [8799, 18799],
    owner: () => ({ version: 1, pid: 4242, port: 8799, nonce: "ab".repeat(32) }),
    probe: async () => ({ kind: "unavailable" }),
    spawn: async () => { throw new Error("duplicate spawn"); },
    sleep: noSleep,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(result, { mode: "failed", conflictOnly: false, unresponsiveOwner: { pid: 4242, port: 8799 } });
  assert.ok(lines.some((line) => line.includes("pid 4242") && line.includes("did not answer health checks on port 8799")));
  assert.ok(lines.some((line) => line.includes("never answered")));
});

test("a live data owner that is not listening yet is reported the same way, still without spawning", async () => {
  const result = await resolvePackagedServer({
    ports: [8799],
    owner: () => ({ version: 1, pid: 4242, port: 8799, nonce: "ab".repeat(32) }),
    probe: async () => ({ kind: "none" }),
    spawn: async () => { throw new Error("duplicate spawn"); },
    sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "failed", conflictOnly: false, unresponsiveOwner: { pid: 4242, port: 8799 } });
});

test("a failure with no live owner keeps the two-field shape older callers expect", async () => {
  const result = await resolvePackagedServer({
    ports: [8799],
    probe: async () => ({ kind: "unavailable" }),
    spawn: async () => { throw new Error("duplicate spawn"); },
    sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "failed", conflictOnly: false });
});

test("an owner that disappears between attempts is not named in the final diagnosis", async () => {
  const owners = [{ version: 1, pid: 100, port: 8799, nonce: "ab".repeat(32) }, null];
  const spawned = [];
  const result = await resolvePackagedServer({
    ports: [8799],
    owner: () => owners.shift() ?? null,
    probe: async () => ({ kind: "unavailable" }),
    spawn: async (port) => { spawned.push(port); return { proc: null, reason: "timeout" }; },
    sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "failed", conflictOnly: false });
  assert.deepEqual(spawned, []);
});

// ---------------------------------------------------------------------------
// A harness that has the port but is still booting (audit HS19).
//
// The harness now binds its port before the boot work — the Infisical
// preload, the registry load, the post-update resume — and answers health
// with `ready: false` until that work is done. Every other route 503s,
// `/api/runtime` included, which is the build handshake. So the launcher has
// to tell "starting" apart from "broken": the first is worth waiting for, and
// the second must never lead to a second harness on the same data directory.

test("probeHarness: a harness that is still booting says so instead of looking unavailable", async () => {
  const seen = await probeHarness({
    port: 8799,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...HARNESS, ready: false, booting: true }),
    }),
  });
  assert.deepEqual(seen, { kind: "booting", pid: 82972 });
});

test("probeHarness: a booting harness never reaches the build handshake", async () => {
  const asked = [];
  const seen = await probeHarness({
    port: 8799,
    owner: { version: 1, pid: 82972, port: 8799, nonce: "ab".repeat(32) },
    expectedBuild: { version: "1.0.0", sourceCommit: "a".repeat(40), apiVersion: 1 },
    fetchImpl: async (url) => {
      asked.push(String(url));
      return { ok: true, status: 200, json: async () => ({ ...HARNESS, ready: false, booting: true }) };
    },
  });
  // An owner-proof check would reject the fixture before the booting branch,
  // so this asserts the shape the real harness answers with: whatever the
  // proof says, /api/runtime is never asked while the harness is booting.
  assert.ok(!asked.some((url) => url.includes("/api/runtime")));
  assert.ok(seen.kind === "booting" || seen.kind === "unavailable");
});

test("resolvePackagedServer waits for a booting harness and then attaches to it", async () => {
  let probes = 0;
  let spawned = 0;
  const result = await resolvePackagedServer({
    ports: [8799],
    probe: async () => {
      probes += 1;
      return probes < 3 ? { kind: "booting", pid: 82972 } : { kind: "botfleet", pid: 82972, static: false };
    },
    spawn: async () => {
      spawned += 1;
      return { proc: {} };
    },
    attachSettleMs: 0,
    bootPollMs: 1,
    sleep: noSleep,
  });
  assert.deepEqual(result, { mode: "attached", port: 8799, pid: 82972, static: false });
  assert.equal(spawned, 0, "a harness that is merely slow must not get a second one beside it");
});

test("resolvePackagedServer gives up on a harness that never finishes booting, without spawning", async () => {
  const logged = [];
  let spawned = 0;
  const result = await resolvePackagedServer({
    ports: [8799],
    probe: async () => ({ kind: "booting", pid: 82972 }),
    spawn: async () => {
      spawned += 1;
      return { proc: {} };
    },
    attempts: 1,
    bootWaitAttempts: 3,
    bootPollMs: 1,
    sleep: noSleep,
    log: (line) => logged.push(line),
  });
  assert.equal(result.mode, "failed");
  assert.equal(spawned, 0, "two harnesses on one data directory is worse than no window");
  assert.ok(logged.some((line) => line.includes("still booting")));
});

test("pollServerIdentity keeps waiting while our own child reports ready:false", async () => {
  let calls = 0;
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 5_000,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () =>
          calls < 3
            ? { app: "botfleet", pid: 4242, static: true, ready: false, booting: true }
            : { app: "botfleet", pid: 4242, static: true, ready: true, booting: false },
      };
    },
  });
  assert.equal(outcome.outcome, "ready");
  assert.equal(calls, 3, "a booting child must be waited for, not reaped as a foreign owner");
});

test("pollServerIdentity still gives up on a child that never finishes booting", async () => {
  let clock = 0;
  const outcome = await pollServerIdentity({
    port: 8799,
    pid: () => 4242,
    bootTimeoutMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ app: "botfleet", pid: 4242, static: true, ready: false, booting: true }),
    }),
  });
  assert.equal(outcome.outcome, "timeout");
});
