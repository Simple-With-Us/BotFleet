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
  recordBridgePairingReplay,
  redeemBridgePairingWindow,
  sha256Hex,
} from "./companion-bridge.mjs";

const NOW = 1_700_000_000_000;
const PROOF = "bridge-proof-token-0001";

function openWindow(overrides = {}) {
  return openBridgePairingWindow({ code: "123456", token: PROOF, ttlSeconds: 300, maxAttempts: 3, nowMs: NOW, ...overrides });
}

function redeem(window, presented, extra = {}) {
  return redeemBridgePairingWindow({ window, presented, nowMs: NOW, pairedDeviceIds: [], ...extra });
}

/** A window the server already spent, with a recorded replay for d-9. */
function spentWithReplay(overrides = {}) {
  const window = openWindow(overrides);
  const first = redeem(window, PROOF);
  assert.equal(first.ok, true);
  const recorded = recordBridgePairingReplay({
    window: first.window, requestId: "pair-request-00000001", credentialDigest: first.credentialDigest, deviceId: "d-9", nowMs: NOW,
  });
  return { window: recorded, credentialDigest: first.credentialDigest };
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

test("percent-encoded dot and slash forms are refused as traversal", () => {
  for (const url of [
    "/api/threads/%2e/fleet",
    "/api/threads/%2E%2E/fleet",
    "/api/threads/%252e/fleet",
    "/api/threads/a%2fb/messages",
    "/api/threads/%c0%af/messages",
    "/api/companion/devices/%2e",
  ]) {
    assert.equal(bridgeRouteDecision("GET", url).status, 404, url);
  }
  const singleEncoded = bridgeRouteDecision("GET", "/api/threads/%252e");
  assert.equal(singleEncoded.ok, true);
  assert.equal(singleEncoded.upstream, "/api/threads/%252e");
});

test("matching strips the query but the upstream keeps it byte for byte", () => {
  const decision = bridgeRouteDecision("GET", "/api/events?since=%3Ccursor%3A42%3E&tail=1");
  assert.equal(decision.ok, true);
  assert.equal(decision.upstream, "/api/events?since=%3Ccursor%3A42%3E&tail=1");
  const device = bridgeRouteDecision("DELETE", "/api/companion/devices/d-1?x=1");
  assert.equal(device.upstream, "/api/companion/devices/d-1?x=1");
});

test("a $-sequence in a path param is inserted verbatim, not expanded", () => {
  const decision = bridgeRouteDecision("GET", "/api/threads/$&");
  assert.equal(decision.ok, true);
  assert.equal(decision.upstream, "/api/threads/$&");
  const quote = bridgeRouteDecision("DELETE", "/api/companion/devices/$'");
  assert.equal(quote.ok, true);
  assert.equal(quote.upstream, "/api/companion/devices/$'");
});

test("pairing windows spend exactly once on a fake clock", () => {
  const window = openWindow();
  assert.equal(window.spent, false);
  assert.equal(window.replay, null);
  assert.ok(!("code" in window), "no cleartext code is persisted");
  assert.ok(!("token" in window), "no cleartext token is persisted");
  assert.equal(window.expiresAtMs, NOW + 300_000);
  const first = redeem(window, PROOF);
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(first.window.spent, true);
  const replay = redeem({ ...first.window, replay: null }, PROOF);
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "window already spent");
});

test("the manual code redeems through its digest, and expiry spends the window", () => {
  const byCode = redeem(openWindow(), "123456");
  assert.equal(byCode.ok, true);
  assert.equal(byCode.replayed, false);
  const expired = redeem(openWindow(), PROOF, { nowMs: NOW + 300_001 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "window expired");
  assert.equal(expired.window.spent, true);
});

test("a corrupt window fails closed instead of guessing forever", () => {
  for (const corrupt of [
    { attemptsLeft: NaN },
    { expiresAtMs: NaN },
    { attemptsLeft: undefined, expiresAtMs: undefined },
  ]) {
    const window = { ...openWindow(), ...corrupt };
    const decision = redeem(window, PROOF);
    assert.equal(decision.ok, false, JSON.stringify(Object.keys(corrupt)));
    assert.equal(decision.window.spent, true);
  }
  const bare = redeem({}, PROOF);
  assert.equal(bare.ok, false);
  assert.equal(bare.window.spent, true);
});

test("a wrong credential costs one attempt and the budget locks", () => {
  let window = openWindow({ maxAttempts: 2 });
  const first = redeem(window, "nope");
  assert.equal(first.ok, false);
  assert.equal(first.window.attemptsLeft, 1);
  assert.equal(first.window.spent, false);
  const second = redeem(first.window, "nope");
  assert.equal(second.window.spent, true);
  const locked = redeem(second.window, PROOF);
  assert.equal(locked.ok, false);
});

test("weak tokens and non-finite clocks are refused loudly, not defaulted", () => {
  for (const overrides of [{ token: "short" }, { token: "" }, { ttlSeconds: Infinity }, { nowMs: NaN }]) {
    assert.throws(() => openWindow(overrides), /requires/);
  }
});

test("replay needs a shaped request id and a digest the window minted", () => {
  const { window, credentialDigest } = spentWithReplay();
  const malformed = redeem(window, PROOF, { requestId: "!!!", pairedDeviceIds: ["d-9"] });
  assert.equal(malformed.ok, false);
  assert.throws(() => recordBridgePairingReplay({ window, requestId: "!!!", credentialDigest, deviceId: "d-9", nowMs: NOW }), /shaped request id/);
  assert.throws(() => recordBridgePairingReplay({ window, requestId: "pair-request-00000002", credentialDigest: sha256Hex("other"), deviceId: "d-9", nowMs: NOW }), /digest this window minted/);
});

test("bad window inputs are refused loudly, not defaulted", () => {
  for (const overrides of [{ code: "12345" }, { ttlSeconds: 0 }, { nowMs: -1 }, { maxAttempts: 0 }]) {
    assert.throws(() => openWindow(overrides), /requires/);
  }
});

test("the same phone request replays its prior result until expiry", () => {
  const { window, credentialDigest } = spentWithReplay();
  const replayed = redeem(window, PROOF, { requestId: "pair-request-00000001", pairedDeviceIds: ["d-9"] });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.deviceId, "d-9");
  void credentialDigest;
});

test("replay needs the same request, the same credential, a paired device, and time left", () => {
  const { window } = spentWithReplay();
  const wrongRequest = redeem(window, PROOF, { requestId: "pair-request-00000002", pairedDeviceIds: ["d-9"] });
  assert.equal(wrongRequest.ok, false);
  const wrongCredential = redeem(window, "123456", { requestId: "pair-request-00000001", pairedDeviceIds: ["d-9"] });
  assert.equal(wrongCredential.ok, false);
  const revoked = redeem(window, PROOF, { requestId: "pair-request-00000001", pairedDeviceIds: [] });
  assert.equal(revoked.ok, false);
  const expired = redeem(window, PROOF, { requestId: "pair-request-00000001", pairedDeviceIds: ["d-9"], nowMs: NOW + 300_001 });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, "window expired");
  const noRequestId = redeem(window, PROOF, { pairedDeviceIds: ["d-9"] });
  assert.equal(noRequestId.ok, false);
  assert.equal(noRequestId.reason, "window already spent");
});

test("recording a replay needs a request id, a digest, and a device", () => {
  const window = openWindow();
  assert.throws(() => recordBridgePairingReplay({ window, credentialDigest: sha256Hex(PROOF), deviceId: "d-1", nowMs: NOW }), /request id/);
  assert.throws(() => recordBridgePairingReplay({ window, requestId: "pair-request-00000002", credentialDigest: "nope", deviceId: "d-1", nowMs: NOW }), /credential digest/);
  assert.throws(() => recordBridgePairingReplay({ window, requestId: "pair-request-00000002", credentialDigest: sha256Hex(PROOF), deviceId: "", nowMs: NOW }), /device id/);
});

test("device credentials match digests only, under a concrete id", () => {
  const devices = [
    { id: "d-1", tokenDigest: sha256Hex(PROOF) },
    { tokenDigest: sha256Hex(PROOF) },
    { id: "", tokenDigest: sha256Hex(PROOF) },
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
  const payload = buildBridgeAlertPayload({ title: "Approval needed", body: "Deploy?", threadId: "t-1", kind: "approval" });
  assert.equal(payload.aps.alert.title, "Approval needed");
  assert.equal(payload.aps.category, "BOTFLEET_APPROVAL");
  assert.equal(payload.aps["interruption-level"], "time-sensitive");
  assert.equal(payload.aps["relevance-score"], 1.0);
  assert.equal(payload.aps["thread-id"], "t-1");
  assert.equal(payload.aps["mutable-content"], 1);
  const quiet = buildBridgeAlertPayload({ title: "Hi", body: "Done", kind: "done" });
  assert.equal(quiet.aps.category, "BOTFLEET_UPDATE");
  assert.equal(quiet.aps["interruption-level"], "active");
  const question = buildBridgeAlertPayload({ title: "Q", body: "Pick one.", kind: "question" });
  assert.equal(question.aps.category, "BOTFLEET_QUESTION");
  assert.equal(question.aps["interruption-level"], "time-sensitive");
  assert.equal(question.aps["relevance-score"], 0.9);
  assert.ok(!("thread-id" in quiet.aps));
});

test("prototype keys cannot smuggle an object into the relevance score", () => {
  for (const kind of ["__proto__", "constructor", "toString"]) {
    const payload = buildBridgeAlertPayload({ title: "t", body: "b", kind });
    assert.equal(payload.aps["relevance-score"], 0.3, kind);
    assert.ok(Number.isFinite(payload.aps["relevance-score"]), kind);
  }
});

test("route rows name every entry the bridge serves", () => {
  assert.ok(BRIDGE_ALLOWED_ROUTES.length >= 10);
  for (const route of BRIDGE_ALLOWED_ROUTES) {
    assert.ok(route.method && route.path && (route.local === true || route.local === false) && route.description);
  }
});
