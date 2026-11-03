import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopStartupRequest, readDesktopStartupReceipt, writeDesktopStartupReceipt } from "../electron/desktop-startup-receipt.mjs";
import { classifyLocalHealth, desktopStartupPreflight, healthTopologyResult, observeDesktopStartup, ownedRuntimePids, waitForStartup } from "./update-botfleet-mac.mjs";

const APP_PID = 401;
const LOCAL_PID = 402;
const UPSTREAM_PID = 9001;
const PORT = 54321;
const RECEIPT = { pid: APP_PID, mode: "remote", uiPort: PORT };
const AUTHENTICATED = { safe: true, mode: "authenticated", pid: LOCAL_PID };

function dependencies({ appPids = [APP_PID], socketPids = [APP_PID], runtime = AUTHENTICATED } = {}) {
  const calls = [];
  return {
    calls,
    appPids,
    listeners: async (port) => { calls.push(["listeners", port]); return socketPids; },
    localRuntime: async () => { calls.push(["localRuntime"]); return runtime; },
  };
}

test("polling retries a torn private receipt then accepts the complete validated response", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-startup-observation-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "desktop-startup.json");
  const build = { app: "botfleet", sourceCommit: "a".repeat(40), sourceDirty: false, version: "0.1.0", apiVersion: 1, uiHash: "b".repeat(64) };
  const request = createDesktopStartupRequest(file, build);
  writeDesktopStartupReceipt(file, build, RECEIPT);
  const complete = readFileSync(file);
  writeFileSync(file, '{"schemaVersion":');
  let now = 0;
  const deps = dependencies();
  const result = await waitForStartup({
    attempt: () => observeDesktopStartup({ readReceipt: () => readDesktopStartupReceipt(file, request), ...deps }),
    now: () => now, wait: async (ms) => { now += ms; writeFileSync(file, complete); },
    timeoutMs: 100, pollMs: 10, what: "desktop", fallback: "not confirmed",
  });
  assert.equal(now, 10);
  assert.deepEqual(result, { safe: true, mode: "remote-desktop", pid: APP_PID });
  assert.deepEqual(deps.calls, [["listeners", PORT]]);
});

test("unreadable confirmation remains unsafe until the bounded polling deadline without leaking its error", async () => {
  let now = 0;
  const deps = dependencies();
  await assert.rejects(waitForStartup({
    attempt: () => observeDesktopStartup({ readReceipt: () => { throw new Error("private parser input"); }, ...deps }),
    now: () => now, wait: async (ms) => { now += ms; },
    timeoutMs: 20, pollMs: 10, what: "desktop", fallback: "not confirmed",
  }), { message: "Desktop startup confirmation is not readable yet" });
  assert.equal(now, 20);
  assert.deepEqual(deps.calls, []);
});

test("remote desktop readiness requires its exact installed PID and kernel UI socket without consulting local runtime", async () => {
  const deps = dependencies();
  deps.localRuntime = async () => assert.fail("remote mode must not probe a local harness");
  assert.deepEqual(await desktopStartupPreflight(RECEIPT, deps), { safe: true, mode: "remote-desktop", pid: APP_PID });
  assert.deepEqual(deps.calls, [["listeners", PORT]]);
});

test("a remote GUI receipt cannot authorize a missing, different or ambiguous installed process", async () => {
  for (const appPids of [[], [LOCAL_PID], [APP_PID, LOCAL_PID], [APP_PID, APP_PID]]) {
    const deps = dependencies({ appPids });
    assert.equal((await desktopStartupPreflight(RECEIPT, deps)).safe, false);
    assert.deepEqual(deps.calls, []);
  }
  assert.equal((await desktopStartupPreflight(null, dependencies())).safe, false);
});

test("remote readiness rejects missing, foreign or ambiguous UI socket owners", async () => {
  for (const socketPids of [[], [UPSTREAM_PID], [LOCAL_PID], [APP_PID, LOCAL_PID], [APP_PID, APP_PID]]) {
    const deps = dependencies({ socketPids });
    deps.localRuntime = async () => assert.fail("remote failure must not probe a local harness");
    assert.equal((await desktopStartupPreflight(RECEIPT, deps)).safe, false);
    assert.deepEqual(deps.calls, [["listeners", PORT]]);
  }
});

test("local desktop readiness accepts a UI socket owned by its GUI or authenticated harness", async () => {
  for (const socketPids of [[APP_PID], [LOCAL_PID]]) {
    const deps = dependencies({ socketPids });
    assert.deepEqual(await desktopStartupPreflight({ ...RECEIPT, mode: "local" }, deps), AUTHENTICATED);
    assert.deepEqual(deps.calls, [["listeners", PORT], ["localRuntime"]]);
  }
});

test("local desktop readiness refuses a GUI receipt without authenticated local runtime", async () => {
  for (const runtime of [
    null,
    undefined,
    { safe: true },
    { safe: false, reason: "harness not ready" },
    { safe: false, mode: "authenticated", pid: LOCAL_PID },
    { safe: true, mode: "legacy", pid: LOCAL_PID },
    { safe: true, mode: "remote-desktop", pid: LOCAL_PID },
  ]) {
    const deps = dependencies({ runtime });
    deps.localRuntime = async () => runtime;
    const result = await desktopStartupPreflight({ ...RECEIPT, mode: "local" }, deps);
    assert.notEqual(result?.safe, true, `unauthenticated mode ${runtime?.mode} must fail closed`);
  }
});

test("authenticated local runtime cannot authorize an unrelated or ambiguous GUI socket", async () => {
  for (const socketPids of [[], [UPSTREAM_PID], [APP_PID, LOCAL_PID], [LOCAL_PID, LOCAL_PID]]) {
    assert.equal((await desktopStartupPreflight({ ...RECEIPT, mode: "local" }, dependencies({ socketPids }))).safe, false);
  }
});

test("unknown modes and malformed PID or port fail closed before any runtime or socket probe", async () => {
  for (const bad of [
    { mode: undefined }, { mode: null }, { mode: "unknown" }, { mode: "REMOTE" },
    { pid: 0 }, { pid: -1 }, { pid: "401" }, { pid: 1.5 },
    { uiPort: 0 }, { uiPort: -1 }, { uiPort: 65536 }, { uiPort: "54321" }, { uiPort: 1.5 },
  ]) {
    const receipt = { ...RECEIPT, ...bad };
    const deps = dependencies({ appPids: [receipt.pid] });
    const result = await desktopStartupPreflight(receipt, deps);
    assert.notEqual(result?.safe, true, JSON.stringify(bad));
    assert.deepEqual(deps.calls, [], JSON.stringify(bad));
  }
});

const HEALTH = { app: "botfleet", pid: LOCAL_PID, ready: true, static: true };
const OWNER = { pid: LOCAL_PID, port: PORT };

function assertExcluded(classified, upstreamPid) {
  assert.notEqual(classified.kind, "botfleet");
  assert.equal(Object.hasOwn(classified, "pid"), false);
  assert.equal(healthTopologyResult([classified]).safe, false);
  assert.equal(ownedRuntimePids({ health: [classified] }).includes(upstreamPid), false);
}

test("only matching kernel listener and private local owner turn health into a local PID", () => {
  const result = classifyLocalHealth(HEALTH, PORT, [LOCAL_PID], OWNER);
  assert.deepEqual(result, { kind: "botfleet", pid: LOCAL_PID, static: true, port: PORT });
  assert.equal(healthTopologyResult([result]).pid, LOCAL_PID);
  assert.deepEqual(ownedRuntimePids({ health: [result] }), [LOCAL_PID]);
});

test("upstream proxy health never contributes its PID to local topology or owned process candidates", () => {
  for (const owner of [null, OWNER, { pid: UPSTREAM_PID, port: PORT }]) {
    const result = classifyLocalHealth({ ...HEALTH, pid: UPSTREAM_PID }, PORT, [APP_PID], owner);
    assert.equal(result.kind, "proxy");
    assertExcluded(result, UPSTREAM_PID);
    const local = classifyLocalHealth(HEALTH, PORT + 1, [LOCAL_PID], { ...OWNER, port: PORT + 1 });
    const topology = healthTopologyResult([result, local]);
    assert.equal(topology.safe, true);
    assert.deepEqual(topology.pids, [LOCAL_PID]);
    assert.deepEqual(ownedRuntimePids({ health: [result, local] }), [LOCAL_PID]);
  }
});

test("numeric PID collisions cannot turn an upstream response into a local owner", () => {
  for (const owner of [null, { pid: LOCAL_PID, port: PORT }, { pid: UPSTREAM_PID, port: PORT + 1 }]) {
    const result = classifyLocalHealth({ ...HEALTH, pid: UPSTREAM_PID }, PORT, [UPSTREAM_PID], owner);
    assertExcluded(result, UPSTREAM_PID);
  }
});

test("missing and mismatching private owners fail closed even when health matches the kernel PID", () => {
  for (const owner of [null, { ...OWNER, pid: APP_PID }, { ...OWNER, port: PORT + 1 }]) {
    assertExcluded(classifyLocalHealth(HEALTH, PORT, [LOCAL_PID], owner), LOCAL_PID);
  }
});

test("missing or ambiguous kernel listeners cannot authorize a reported health PID", () => {
  for (const listeners of [[], [LOCAL_PID, APP_PID], [LOCAL_PID, LOCAL_PID]]) {
    const result = classifyLocalHealth(HEALTH, PORT, listeners, OWNER);
    assert.equal(result.kind, "unavailable");
    assertExcluded(result, LOCAL_PID);
  }
});

test("booting upstream responses remain proxies while a genuinely local boot is unavailable", () => {
  for (const boot of [{ ready: false }, { booting: true }, { ready: false, booting: true }]) {
    const upstream = classifyLocalHealth({ ...HEALTH, ...boot, pid: UPSTREAM_PID }, PORT, [APP_PID], OWNER);
    assert.equal(upstream.kind, "proxy");
    assertExcluded(upstream, UPSTREAM_PID);
    const local = classifyLocalHealth({ ...HEALTH, ...boot }, PORT, [LOCAL_PID], OWNER);
    assert.equal(local.kind, "unavailable");
    assert.equal(local.reason, "booting");
    assertExcluded(local, LOCAL_PID);
  }
});

test("foreign and malformed health never contributes a local runtime PID", () => {
  for (const body of [null, {}, { ...HEALTH, app: "other" }, { ...HEALTH, pid: 0 }, { ...HEALTH, pid: "402" }, { ...HEALTH, pid: 1.5 }]) {
    const classified = classifyLocalHealth(body, PORT, [LOCAL_PID], OWNER);
    assert.equal(classified.kind, "foreign");
    assertExcluded(classified, LOCAL_PID);
  }
});
