// The bridge contract, proved with fakes (BF-2652).
//
// Every test runs against pure helpers with a fake clock and a fake device
// registry: no listener is started, no port is bound, no credential leaves
// a digest, and nothing is sent anywhere.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BRIDGE_ALLOWED_ROUTES,
  bridgeDeviceDecision,
  bridgeRouteDecision,
  buildBridgeAlertPayload,
  openBridgePairingWindow,
  pushSenderForDevice,
  redeemBridgePairingWindow,
  sha256Hex,
} from "./companion-bridge.mjs";

const NOW = 1_700_000_000_000;
const PROOF = "bridge-proof-1";

function openWindow(overrides = {}) {
  return openBridgePairingWindow({ code: "123456", token: PROOF, ttlSeconds: 300, maxAttempts: 3, nowMs: NOW, ...overrides });
}

test("every companion route the Phone tab needs is on the bridge", () => {
  for (const [method, url, local] of [
    ["GET", "/api/companion/endpoints", true],
    ["POST", "/api/companion/pairing/open", true],
    ["POST", "/api/companion/pairing/redeem", true],
    ["GET", "/api/companion/devices", true],
    ["DELETE", "/api/companion/devices/d-1", true],
    ["GET", "/api/fleet", false],
    ["GET", "/api/threads/t-1", false],
    ["POST", "/api/threads/t-1/messages", false],
    ["POST", "/api/threads/t-1/interrupt", false],
    ["GET", "/api/events", false],
  ]) {
    const decision = bridgeRouteDecision(method, url);
    assert.equal(decision.ok, true, `${method} ${url}`);
    assert.equal(decision.local, local, `${method} ${url} locality`);
  }
});

test("unknown paths, wrong methods, and traversal are refused", () => {
  assert.equal(bridgeRouteDecision("GET", "/api/admin").ok, false);
  assert.equal(bridgeRouteDecision("GET", "/api/admin").status, 404);
  const wrongMethod = bridgeRouteDecision("POST", "/api/fleet");
  assert.equal(wrongMethod.ok, false);
  assert.equal(wrongMethod.status, 405);
  assert.equal(bridgeRouteDecision("GET", "/api/threads/../fleet").status, 404);
  assert.equal(bridgeRouteDecision("GET", "/api/threads//messages").status, 404);
  assert.equal(bridgeRouteDecision("GET", "/api/threads/t-1/messages/extra").status, 404);
});

test("matching strips the query but the upstream keeps it byte for byte", () => {
  const decision = bridgeRouteDecision("GET", "/api/events?since=%3Ccursor%3A42%3E&tail=1");
  assert.equal(decision.ok, true);
  assert.equal(decision.upstream, "/api/events?since=%3Ccursor%3A42%3E&tail=1");
  const device = bridgeRouteDecision("DELETE", "/api/companion/devices/d-1?x=1");
  assert.equal(device.upstream, "/api/companion/devices/d-1?x=1");
});

test("pairing windows spend exactly once on a fake clock", () => {
  const window = openWindow();
  assert.equal(window.spent, false);
  assert.equal(window.expiresAtMs, NOW + 300_000);
  const first = redeemBridgePairingWindow({ window, presented: PROOF, nowMs: NOW + 1_000 });
  assert.equal(first.ok, true);
  assert.equal(first.window.spent, true);
  const replay = redeemBridgePairingWindow({ window: first.window, presented: PROOF, nowMs: NOW + 2_000 });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "window already spent");
});

test("the manual code redeems too, and expiry spends the window", () => {
  const byCode = redeemBridgePairingWindow({ window: openWindow(), presented: "123456", nowMs: NOW });
  assert.equal(byCode.ok, true);
  const expired = redeemBridgePairingWindow({ window: openWindow(), presented: PROOF, nowMs: NOW + 300_001 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "window expired");
  assert.equal(expired.window.spent, true);
});

test("a wrong credential costs one attempt and the budget locks", () => {
  let window = openWindow({ maxAttempts: 2 });
  const first = redeemBridgePairingWindow({ window, presented: "nope", nowMs: NOW });
  assert.equal(first.ok, false);
  assert.equal(first.window.attemptsLeft, 1);
  assert.equal(first.window.spent, false);
  const second = redeemBridgePairingWindow({ window: first.window, presented: "nope", nowMs: NOW });
  assert.equal(second.window.spent, true);
  const locked = redeemBridgePairingWindow({ window: second.window, presented: PROOF, nowMs: NOW });
  assert.equal(locked.ok, false);
});

test("bad window inputs are refused loudly, not defaulted", () => {
  for (const overrides of [{ code: "12345" }, { token: "" }, { ttlSeconds: 0 }, { nowMs: -1 }]) {
    assert.throws(() => openWindow(overrides), /requires a 6-digit code/);
  }
});

test("device credentials match digests only", () => {
  const devices = [
    { id: "d-1", tokenDigest: sha256Hex(PROOF) },
    { id: "broken", tokenDigest: "not-hex" },
  ];
  const known = bridgeDeviceDecision({ presentedToken: PROOF, devices });
  assert.deepEqual(known, { ok: true, deviceId: "d-1" });
  assert.deepEqual(bridgeDeviceDecision({ presentedToken: "unknown", devices }), { ok: false, reason: "unknown device" });
  assert.deepEqual(bridgeDeviceDecision({ presentedToken: "", devices }), { ok: false, reason: "device credential required" });
  assert.deepEqual(bridgeDeviceDecision({ presentedToken: PROOF, devices: [] }), { ok: false, reason: "unknown device" });
});

test("one device never has two senders", () => {
  assert.equal(pushSenderForDevice({ serverOwnsPairing: true, macOwnsPairing: true }), "server");
  assert.equal(pushSenderForDevice({ serverOwnsPairing: true, macOwnsPairing: false }), "server");
  assert.equal(pushSenderForDevice({ serverOwnsPairing: false, macOwnsPairing: true }), "mac");
  assert.equal(pushSenderForDevice({}), "none");
});

test("the alert payload mirrors the native shape", () => {
  const payload = buildBridgeAlertPayload({ title: "Approval needed", body: "Deploy?", threadId: "t-1", kind: "approval", timeSensitive: true });
  assert.equal(payload.aps.alert.title, "Approval needed");
  assert.equal(payload.aps.category, "approval");
  assert.equal(payload.aps["interruption-level"], "time-sensitive");
  assert.equal(payload.aps["relevance-score"], 1.0);
  assert.equal(payload.aps["thread-id"], "t-1");
  assert.equal(payload.aps["mutable-content"], 1);
  const quiet = buildBridgeAlertPayload({ title: "Hi", body: "Done", kind: "done" });
  assert.equal(quiet.aps["interruption-level"], "active");
  assert.ok(!("thread-id" in quiet.aps));
});

test("the route table names every entry it serves", () => {
  assert.ok(BRIDGE_ALLOWED_ROUTES.length >= 10);
  for (const route of BRIDGE_ALLOWED_ROUTES) {
    assert.ok(route.method && route.path && typeof route.local === "boolean" && route.description);
  }
});
