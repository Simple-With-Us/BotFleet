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
const PROOF = "omb_pair_" + "a".repeat(43);

/** The window fields the bridge owns; every other key is caller metadata. */
const RESERVED_WINDOW_FIELDS = new Set(["codeDigest", "tokenDigest", "expiresAtMs", "attemptsLeft", "spent", "replay"]);

function openWindow(overrides = {}) {
  return openBridgePairingWindow({ code: "123456", token: PROOF, ttlSeconds: 300, maxAttempts: 3, nowMs: NOW, ...overrides });
}

function redeem(window, presented, extra = {}) {
  return redeemBridgePairingWindow({ window, presented, nowMs: NOW, pairedDeviceIds: [], ...extra });
}

/** A window the server already spent, with an atomic replay for d-9. */
function spentWithReplay(overrides = {}) {
  const window = openWindow(overrides);
  const first = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(first.ok, true);
  assert.ok(first.window.replay, "replay is recorded atomically with the spend");
  assert.equal(first.window.replay.deviceId, "d-9");
  return { window: first.window, credentialDigest: first.credentialDigest };
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
  for (const overrides of [{ token: "short" }, { token: "" }, { token: "a".repeat(52) }, { token: "omb_pair_" + "a".repeat(42) }, { token: "omb_pair_" + "a".repeat(43) + "b" }, { ttlSeconds: Infinity }, { nowMs: NaN }]) {
    assert.throws(() => openWindow(overrides), /requires/);
  }
  // The native shape itself opens fine.
  assert.equal(openWindow().tokenDigest, sha256Hex(PROOF));
});

test("replay needs a shaped request id, and a malformed one means no replay", () => {
  const { window } = spentWithReplay();
  const malformed = redeem(window, PROOF, { requestId: "!!!", pairedDeviceIds: ["d-9"] });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, "window already spent");
  // A malformed request id on an unspent window succeeds without recording.
  const plain = redeem(openWindow(), PROOF, { requestId: "!!!", replayDeviceId: "d-9" });
  assert.equal(plain.ok, true);
  assert.equal(plain.window.replay, null);
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

test("a fresh redeem and its replay report the same fields", () => {
  // The caller reads one result shape on both paths, so a fresh redeem
  // reports the named device instead of leaving it undefined.
  const fresh = redeem(openWindow(), PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.replayed, false);
  assert.equal(fresh.deviceId, "d-9");
  assert.equal(fresh.credentialDigest, sha256Hex(PROOF));
  const replayed = redeem(fresh.window, PROOF, { requestId: "pair-request-00000001", pairedDeviceIds: ["d-9"] });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.deviceId, "d-9");
  assert.equal(replayed.credentialDigest, sha256Hex(PROOF));
  assert.deepEqual(Object.keys(replayed).sort(), Object.keys(fresh).sort());
  // A redeem that named no device reports an empty device id, not a missing one.
  const unnamed = redeem(openWindow(), PROOF);
  assert.equal(unnamed.ok, true);
  assert.equal(unnamed.deviceId, "");
});

test("caller metadata is bounded: at most eight small keys survive", () => {
  const crowded = { ...openWindow() };
  for (let i = 0; i < 12; i += 1) crowded[`tag-${i}`] = `v${i}`;
  crowded.big = "x".repeat(2000);
  const decision = redeem(crowded, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  const kept = Object.keys(decision.window).filter((k) => k.startsWith("tag-"));
  assert.equal(kept.length, 8);
  assert.equal(decision.window.big, undefined);
});

test("a spent window without a recorded replay cannot be resurrected", () => {
  // Without replayDeviceId there is no replay to record: the window
  // spends exactly once and a retry is refused instead of half-replaying.
  const first = redeem(openWindow(), PROOF, { requestId: "pair-request-00000001", pairedDeviceIds: [] });
  assert.equal(first.ok, true);
  assert.equal(first.window.replay, null);
  assert.equal(first.window.spent, true);
  const retry = redeem(first.window, PROOF, { requestId: "pair-request-00000001", pairedDeviceIds: ["d-9"] });
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "window already spent");
});

test("caller metadata survives the round trip instead of being dropped", () => {
  const window = { ...openWindow(), note: "operator-note", customCount: 7 };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.equal(decision.window.note, "operator-note");
  assert.equal(decision.window.customCount, 7);
  // Prototype pollution stays out even when the input tries it.
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"codeDigest":"x"}');
  const cleaned = redeem({ ...openWindow(), ...hostile }, PROOF, { requestId: "pair-request-00000001" });
  assert.equal({}.polluted, undefined);
  assert.equal(cleaned.ok, true);
});

test("a cleartext credential in a stored window never survives a redeem", () => {
  const window = { ...openWindow(), token: PROOF, code: "123456", credential: "cleartext-secret", credentialDigest: "not-a-real-digest" };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(!("token" in decision.window), "no cleartext token comes back out");
  assert.ok(!("code" in decision.window), "no cleartext code comes back out");
  assert.ok(!("credential" in decision.window), "no cleartext credential comes back out");
  assert.ok(!("credentialDigest" in decision.window), "no credential digest comes back out");
  // The stored cleartext is never the credential that redeems the window.
  const other = { ...openWindow(), token: "omb_pair_" + "b".repeat(43) };
  const refused = redeem(other, "omb_pair_" + "b".repeat(43));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "bad credential");
});

test("a credential-shaped caller field name is dropped too", () => {
  const window = { ...openWindow(), pairingToken: "cleartext", smsCode: "654321", postcode: "60601", note: "kept" };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(!("pairingToken" in decision.window), "a credential word in the name drops the field");
  assert.ok(!("smsCode" in decision.window), "a credential word in the name drops the field");
  assert.equal(decision.window.postcode, "60601", "an innocent name keeps its value");
  assert.equal(decision.window.note, "kept");
});

test("an acronym-prefixed credential name does not survive a redeem", () => {
  // An acronym prefix used to hide the credential word from the splitter.
  const window = { ...openWindow(), APIToken: "cleartext", SMSCode: "654321", JWTToken: "cleartext", TOKENValue: "cleartext" };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  for (const key of ["APIToken", "SMSCode", "JWTToken", "TOKENValue"]) {
    assert.ok(!(key in decision.window), `${key} must not survive a redeem`);
  }
});

test("a concatenated credential name does not survive a redeem", () => {
  // One unbroken lowercase run leaves no word edge to split on, so the name
  // is read as a whole run instead.
  const window = { ...openWindow(), pairingtoken: "cleartext", authtoken: "cleartext", token123: "cleartext", smscode: "654321" };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  for (const key of ["pairingtoken", "authtoken", "token123", "smscode"]) {
    assert.ok(!(key in decision.window), `${key} must not survive a redeem`);
  }
});

test("a benign Code-suffixed field survives the round trip", () => {
  // The generic code word no longer strips a benign field on its own: the
  // benign names are listed explicitly, and every other name is dropped.
  const window = { ...openWindow(), statusCode: "ok", exitCode: "0", postcode: "60601", unicode: "yes", encode: "utf8", decode: "utf8" };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.equal(decision.window.statusCode, "ok");
  assert.equal(decision.window.exitCode, "0");
  assert.equal(decision.window.postcode, "60601");
  assert.equal(decision.window.unicode, "yes");
  assert.equal(decision.window.encode, "utf8");
  assert.equal(decision.window.decode, "utf8");
});

test("a credential-shaped value under an allowlisted name is dropped", () => {
  // The allowlist rescues a name, never a value: a caller that renames a
  // cleartext credential into a benign field still loses it.
  const window = {
    ...openWindow(),
    statusCode: PROOF,
    encode: "123456",
    postcode: "st." + "a".repeat(20),
    unicode: "Bearer " + "b".repeat(12),
  };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  for (const key of ["statusCode", "encode", "postcode", "unicode"]) {
    assert.ok(!(key in decision.window), `${key} must not keep a credential value`);
  }
});

test("a bare json web token and a pem private key are dropped under any name", () => {
  // The two shapes the module does not mint itself but a caller can still
  // persist: a JSON web token and a PEM private key block. Both are read
  // out of the value, so renaming them into a benign field does not help.
  const jwt = "eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + "." + "eyJzdWIiOiIxIn0" + "." + "c2lnbmF0dXJl";
  const pem = "-----BEGIN " + "PRIVATE KEY" + "-----\nMIIBVgIBADANBg==\n-----END " + "PRIVATE KEY" + "-----\n";
  const window = { ...openWindow(), statusCode: jwt, encode: pem };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(!("statusCode" in decision.window), "a json web token must not keep a cleartext value");
  assert.ok(!("encode" in decision.window), "a pem private key must not keep a cleartext value");
});

test("the window's own credential is dropped under any name by its digest", () => {
  // The digest reading is exact and does not depend on the value looking
  // like a credential: a value whose digest is the stored code digest is
  // that credential, whatever it is written as and whatever it is named.
  const held = "plain-text-credential";
  const window = { ...openWindow(), codeDigest: sha256Hex(held), statusCode: held };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(!("statusCode" in decision.window), "the window's own code must not ride back out in cleartext");
});

test("a credential nested inside a caller object is dropped", () => {
  // A caller value that is an object is kept as that object, so a
  // credential nested inside it would ride back out unless the walk
  // descends into it.
  const window = {
    ...openWindow(),
    note: { label: "operator note", secret: "cleartext-value" },
    list: ["plain", { nested: PROOF }],
    nested: { deeper: { token: "cleartext" } },
  };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  for (const key of ["note", "list", "nested"]) {
    assert.ok(!(key in decision.window), `${key} must not keep a nested credential`);
  }
});

test("a value with a custom toJSON cannot smuggle a credential past the check", () => {
  // The value is checked as the JSON the caller's own toJSON writes, so a
  // toJSON that hides a cleartext credential is checked as a benign string.
  // The window therefore has to keep what was checked, not the live object
  // the toJSON spoke for.
  const window = {
    ...openWindow(),
    note: { label: "operator note", token: PROOF, toJSON() { return "benign-looking"; } },
  };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.equal(decision.window.note, "benign-looking", "the window keeps the checked value");
  assert.ok(!JSON.stringify(decision.window).includes(PROOF), "the hidden credential does not ride back out");
});

test("a getter that answers twice cannot smuggle a credential past the check", () => {
  // The window reads a value once and keeps what it read. A getter that
  // answers benignly the first time and with a credential the second time
  // must never be read a second time.
  let reads = 0;
  const window = { ...openWindow() };
  Object.defineProperty(window, "note", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? "operator-note" : PROOF;
    },
  });
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.equal(reads, 1, "the window reads the value once");
  assert.equal(decision.window.note, "operator-note");
  assert.ok(!JSON.stringify(decision.window).includes(PROOF), "the second answer does not ride back out");
});

test("a credential embedded in a longer value is dropped", () => {
  // The pairing token and the pairing code are matched as substrings, so
  // writing either inside a longer note does not carry it back out.
  const window = {
    ...openWindow(),
    statusCode: `the code is 123456 for today`,
    encode: `token omb_pair_${"a".repeat(43)} attached`,
  };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  for (const key of ["statusCode", "encode"]) {
    assert.ok(!(key in decision.window), `${key} must not keep an embedded credential`);
  }
});

test("a benign long phrase is not read as a credential", () => {
  // The authorization shape is scoped to the schemes it names, so an
  // ordinary description that ends in a long word keeps its value.
  const window = {
    ...openWindow(),
    statusCode: "operator configuration",
    encode: "utf8 with an explanation",
    unicode: "please review the documentation",
  };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.equal(decision.window.statusCode, "operator configuration");
  assert.equal(decision.window.encode, "utf8 with an explanation");
  assert.equal(decision.window.unicode, "please review the documentation");
});

test("a longer number is not read as a six digit code", () => {
  // The six digit shape is bounded by digit lookarounds, so a longer run of
  // digits is not read as a code.
  const window = { ...openWindow(), statusCode: 20261122, postcode: "20261122" };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.equal(decision.window.statusCode, 20261122);
  assert.equal(decision.window.postcode, "20261122");
});

test("a benign value under an allowlisted name survives", () => {
  const window = { ...openWindow(), statusCode: 200, postcode: "60601", unicode: "yes", encode: "utf8" };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.equal(decision.window.statusCode, 200);
  assert.equal(decision.window.postcode, "60601");
  assert.equal(decision.window.unicode, "yes");
  assert.equal(decision.window.encode, "utf8");
});

test("a credential-shaped value under a credential name is dropped", () => {
  const window = { ...openWindow(), pairingtoken: PROOF, token: "123456", secret: "st." + "a".repeat(20) };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  for (const key of ["pairingtoken", "token", "secret"]) {
    assert.ok(!(key in decision.window), `${key} must not survive a redeem`);
  }
});

test("the credential names drop and the benign names keep their value", () => {
  const window = {
    ...openWindow(),
    APIToken: "a",
    SMSCode: "b",
    JWTToken: "c",
    TOKENValue: "d",
    pairingtoken: "e",
    authtoken: "f",
    token123: "g",
    smscode: "h",
    shipping: "ship",
    mapping: "map",
    coping: "cope",
    customCount: 7,
    hostname: "host",
    duration: 12,
    deviceId: "d-1",
  };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  for (const key of ["APIToken", "SMSCode", "JWTToken", "TOKENValue", "pairingtoken", "authtoken", "token123", "smscode"]) {
    assert.ok(!(key in decision.window), `${key} must not survive a redeem`);
  }
  assert.equal(decision.window.shipping, "ship");
  assert.equal(decision.window.mapping, "map");
  assert.equal(decision.window.coping, "cope");
  assert.equal(decision.window.customCount, 7);
  assert.equal(decision.window.hostname, "host");
  assert.equal(decision.window.duration, 12);
  assert.equal(decision.window.deviceId, "d-1");
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

test("a benign wide value survives the round trip", () => {
  // A wide but harmless value is still under the size gate, so the value
  // check reads it through its serialized form and finds nothing that
  // carries a credential: it comes back whole.
  const wide = Array.from({ length: 300 }, () => 1);
  const window = { ...openWindow(), wideNote: wide };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(Array.isArray(decision.window.wideNote), "a benign wide value comes back");
  assert.equal(decision.window.wideNote.length, 300);
});

test("a benign deep value survives the round trip", () => {
  // A value nested eight levels deep is under the size gate too, and the
  // walk reads the structure its serialized form describes, so a value
  // that is merely deep is kept.
  let deep = "bottom-note";
  for (let level = 0; level < 8; level += 1) deep = { [`level${level}`]: deep };
  const window = { ...openWindow(), deepNote: deep };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(decision.window.deepNote, "a benign deep value comes back");
  assert.equal(decision.window.deepNote.level7.level6.level5.level4.level3.level2.level1.level0, "bottom-note");
});

test("a credential nested deep is still dropped", () => {
  // The depth bound is gone, so the security direction is proved another
  // way: a credential at the bottom of a deep object is still found and
  // the whole value is still dropped.
  let deep = PROOF;
  for (let level = 0; level < 8; level += 1) deep = { [`level${level}`]: deep };
  const window = { ...openWindow(), deepNote: deep };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(!("deepNote" in decision.window), "a credential nested deep must not survive");
});

test("the window scan stops at the visited cap", () => {
  // Two hundred skipped keys sit in front of a benign one, so the scan
  // reaches its visited cap before it ever looks at the benign key: the
  // key behind the cap does not come back, and the window's own fields do.
  const window = { ...openWindow() };
  for (let index = 0; index < 200; index += 1) window[`pairingToken-${index}`] = "cleartext";
  window.afterCap = "behind-the-cap";
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(!("afterCap" in decision.window), "the scan stops at the visited cap");
  assert.equal(decision.window.codeDigest, window.codeDigest);
  assert.equal(decision.window.tokenDigest, window.tokenDigest);
  assert.equal(decision.window.expiresAtMs, window.expiresAtMs);
  assert.equal(decision.window.attemptsLeft, window.attemptsLeft);
  assert.equal(decision.window.spent, true);
  const kept = Object.keys(decision.window).filter((key) => !RESERVED_WINDOW_FIELDS.has(key));
  assert.ok(kept.length <= 8, `at most eight kept keys survive, got ${kept.length}`);
});

test("a benign key before the visited cap still survives", () => {
  // The cap is not a blanket drop: a benign key in front of the skipped
  // keys is still kept.
  const window = { ...openWindow(), beforeCap: "kept-before-the-cap" };
  for (let index = 0; index < 200; index += 1) window[`pairingToken-${index}`] = "cleartext";
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.equal(decision.window.beforeCap, "kept-before-the-cap");
});
