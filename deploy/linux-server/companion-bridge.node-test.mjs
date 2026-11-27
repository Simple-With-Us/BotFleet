// The bridge contract, proved with fakes (BF-2652).
//
// Every test runs against pure helpers with a fake clock and a fake device
// registry: no listener is started, no port is bound, no credential leaves
// a digest, and nothing is sent anywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BRIDGE_ALLOWED_ROUTES,
  BRIDGE_BOT_ORGANIZE_FIELDS,
  BRIDGE_BOT_ORGANIZE_ROUTE_PATTERN,
  BRIDGE_MAX_ENDPOINTS,
  BRIDGE_PAIR_REPLAY_REFUSAL,
  BRIDGE_PROFILE_PATCH_FIELDS,
  BRIDGE_PROFILE_PATCH_ROUTE_PATTERN,
  BRIDGE_SERVER_NAME,
  BRIDGE_WITHHELD_RESPONSE_KEYS,
  MAX_BRIDGE_SSE_EVENT_BYTES,
  bridgeBodyCheck,
  bridgeBotOrganizeDenial,
  bridgeCleanDeviceName,
  bridgeCleanOrigin,
  bridgeDeviceDecision,
  bridgeEndpointKind,
  bridgeEndpoints,
  bridgeIsJson,
  bridgeLocalRouteRequiresDevice,
  bridgePairRefusalSentence,
  bridgeParseOrigins,
  bridgeProfilePatchDenial,
  bridgeRouteDecision,
  bridgeScrub,
  bridgeScrubWireJson,
  buildBridgeAlertPayload,
  buildBridgeLiveActivityContent,
  buildBridgeLiveActivityPayload,
  createBridgeSseScrubber,
  liveActivityTopic,
  openBridgePairingWindow,
  pushSenderForDevice,
  redeemBridgePairingWindow,
  sha256Hex,
  validateBridgePushToken,
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

/** The bridge rows that forward to the harness, health excluded: the copy of
 *  the sidecar's allowlist. */
function mirroredHarnessRoutes() {
  return BRIDGE_ALLOWED_ROUTES.filter((route) => route.local === false && route.path !== "/api/health");
}

/**
 * Read the Mac sidecar's allowlist as text. The two lists are written in two
 * languages and nothing else ties them together, so this is the only place
 * the copy can be checked against its source.
 */
function sidecarAllowList() {
  const source = readFileSync(new URL("../../companion/src/routes.ts", import.meta.url), "utf8");
  const opener = "const ALLOWED: ReadonlyArray<{ method: string; path: RegExp }> = [";
  const start = source.indexOf(opener);
  assert.notEqual(start, -1, "the sidecar still declares its ALLOWED list where this test reads it");
  const end = source.indexOf("\n];", start);
  assert.notEqual(end, -1, "the sidecar's ALLOWED list still closes where this test reads it");
  const block = source.slice(start, end);
  const entries = [];
  let inlineRows = 0;
  let namedRows = 0;
  for (const line of block.split("\n")) {
    const inline = line.match(/^\s*\{ method: "([A-Z]+)", path: (\/.*\/[a-z]*),? \},?\s*$/);
    if (inline) {
      entries.push(`${inline[1]} ${inline[2]}`);
      inlineRows += 1;
      continue;
    }
    const named = line.match(/^\s*([A-Z_]+),\s*$/);
    if (!named) continue;
    const definition = source.match(
      new RegExp(`const ${named[1]} = \\{\\s*method: "([A-Z]+)",\\s*path: (\\/.*\\/[a-z]*),?\\s*\\} as const;`),
    );
    assert.ok(definition, `${named[1]} is still a method-and-path constant`);
    entries.push(`${definition[1]} ${definition[2]}`);
    namedRows += 1;
  }
  // A parser that matched nothing would pass forever, so every row the block
  // declares has to come back. The first line declares one `path:` in its
  // type annotation, which is not a row, and two rows are named constants.
  assert.equal(inlineRows, block.match(/\bpath:/g).length - 1, "every inline row of the sidecar list was read");
  assert.equal(namedRows, (block.match(/^\s*[A-Z][A-Z_]+,\s*$/gm) ?? []).length, "every named row was read");
  assert.equal(namedRows, 2, "the two named rows are the organize route and the cloud desktop join");
  return entries;
}

/** One quoted list out of the sidecar source, by the name of its constant. */
function sidecarQuotedList(constant) {
  const source = readFileSync(new URL("../../companion/src/routes.ts", import.meta.url), "utf8");
  const opener = source.indexOf(`const ${constant} = [`);
  assert.notEqual(opener, -1, `the sidecar still declares ${constant} where this test reads it`);
  const closer = source.indexOf("] as const;", opener);
  assert.notEqual(closer, -1, `${constant} still closes where this test reads it`);
  const body = source.slice(opener + `const ${constant} = [`.length, closer);
  // The list carries comments, and a comment may quote a word, so only one
  // quoted string on its own line is a member.
  const members = [...body.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((match) => match[1]);
  assert.ok(members.length > 0, `${constant} still has members`);
  return members;
}

test("the harness routes the bridge forwards are the sidecar's allowlist, pattern for pattern", () => {
  const sidecar = new Set(sidecarAllowList());
  const bridge = new Set(mirroredHarnessRoutes().map((route) => `${route.method} /${route.pattern.source}/${route.pattern.flags}`));
  // Nothing is forwarded that the sidecar does not allow: the bridge can
  // never be the wider door.
  for (const entry of bridge) {
    assert.ok(sidecar.has(entry), `the bridge forwards ${entry}, which the sidecar does not allow`);
  }
  // And everything the sidecar allows is forwarded, except the rows named
  // here. A row added to the sidecar later fails this test until someone
  // decides, in this diff, whether a phone may reach it through the bridge.
  const local = new Set(BRIDGE_ALLOWED_ROUTES.filter((route) => route.local === true).map((route) => `${route.method} ${route.path}`));
  const notForwarded = [...sidecar].filter((entry) => !bridge.has(entry)).sort();
  assert.deepEqual(
    notForwarded,
    [
      "GET /^\\/api\\/companion\\/endpoints$/",
      "GET /^\\/api\\/companion\\/push-health$/",
      "POST /^\\/api\\/bots\\/[\\w-]+\\/computer\\/join$/",
      "POST /^\\/api\\/companion\\/live-activity-token$/",
      "POST /^\\/api\\/update\\/check$/",
      "POST /^\\/api\\/update\\/run$/",
      "POST /^\\/api\\/companion\\/push-token$/",
    ].sort(),
  );
  for (const [method, path] of [
    ["GET", "/api/companion/endpoints"],
    ["GET", "/api/companion/push-health"],
    ["POST", "/api/companion/live-activity-token"],
    ["POST", "/api/companion/push-token"],
  ]) {
    assert.ok(local.has(`${method} ${path}`), `${method} ${path} is served by the bridge itself`);
  }
  // The one sidecar route with no bridge counterpart stays closed. On the
  // Mac it needs a per-device grant the computer owner switches on; the
  // bridge has none, so it is not open for every paired phone.
  const join = bridgeRouteDecision("POST", "/api/bots/b-1/computer/join");
  assert.equal(join.ok, false);
  assert.equal(join.status, 404);
  // The two update actions stay closed for the same reason in kind: they
  // stop and replace the harness, and on this host that is a production
  // service. The read-only status row is the one update route a phone gets.
  for (const path of ["/api/update/check", "/api/update/run"]) {
    const decision = bridgeRouteDecision("POST", path);
    assert.equal(decision.ok, false, `POST ${path} is not a bridge route`);
    assert.equal(decision.status, 404);
  }
  assert.equal(bridgeRouteDecision("GET", "/api/update/status").ok, true);
});

test("the two checked bodies use the sidecar's own routes and field lists", () => {
  const source = readFileSync(new URL("../../companion/src/routes.ts", import.meta.url), "utf8");
  const profile = source.match(/export function isCompanionProfilePatch\([^)]*\): boolean \{\s*return method === "PATCH" && (\/.*\/)\.test\(path\);/);
  assert.ok(profile, "the sidecar still names its profile route where this test reads it");
  assert.equal(BRIDGE_PROFILE_PATCH_ROUTE_PATTERN.source, profile[1].slice(1, -1));
  const organize = source.match(/const COMPANION_BOT_ORGANIZE_ROUTE = \{\s*method: "([A-Z]+)",\s*path: (\/.*\/),?\s*\} as const;/);
  assert.ok(organize, "the sidecar still names its organize route where this test reads it");
  assert.equal(BRIDGE_BOT_ORGANIZE_ROUTE_PATTERN.source, organize[2].slice(1, -1));
  assert.deepEqual([...BRIDGE_PROFILE_PATCH_FIELDS], sidecarQuotedList("COMPANION_PROFILE_PATCH_FIELDS"));
  assert.deepEqual([...BRIDGE_BOT_ORGANIZE_FIELDS], sidecarQuotedList("COMPANION_BOT_ORGANIZE_FIELDS"));
  const wire = readFileSync(new URL("../../companion/src/wire.ts", import.meta.url), "utf8");
  const withheld = wire.match(/const WITHHELD_KEYS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(withheld, "the sidecar still names its withheld keys where this test reads it");
  assert.deepEqual(
    [...BRIDGE_WITHHELD_RESPONSE_KEYS],
    [...withheld[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
});

test("every forwarded row is a paired-device route anchored at both ends", () => {
  for (const route of mirroredHarnessRoutes()) {
    assert.equal(route.local, false, `${route.method} ${route.path}`);
    assert.equal(route.requiresDevice, true, `${route.method} ${route.path}`);
    assert.ok(route.pattern instanceof RegExp, `${route.method} ${route.path} matches on the raw path`);
    assert.ok(route.pattern.source.startsWith("^") && route.pattern.source.endsWith("$"), `${route.method} ${route.path} is anchored`);
    assert.equal(route.pattern.global, false, `${route.method} ${route.path} keeps no state between calls`);
  }
  // An id is `[\w-]+` and nothing wider, so an encoded character inside one
  // fails to match and the door stays closed, the way it does on the Mac.
  for (const url of [
    "/api/bots/b%2D1/messages",
    "/api/bots/%252e",
    "/api/bots/b%2F1/messages",
    "/api/threads/t-1/messages/m%2E1/image",
  ]) {
    assert.equal(bridgeRouteDecision("GET", url).status, 404, url);
    assert.equal(bridgeRouteDecision("POST", url).status, 404, url);
  }
});

test("the routes a phone calls before it is paired need no device, and nothing else is let off", () => {
  const health = bridgeRouteDecision("GET", "/api/health");
  assert.equal(health.ok, true);
  assert.equal(health.local, false);
  assert.equal(health.route.requiresDevice, false);
  const pair = bridgeRouteDecision("POST", "/api/pair");
  assert.equal(pair.ok, true);
  assert.equal(pair.local, true);
  assert.equal(pair.route.requiresDevice, false);
  const advertisement = bridgeRouteDecision("GET", "/api/companion/endpoints");
  assert.equal(advertisement.ok, true);
  assert.equal(advertisement.route.requiresDevice, false);
  // Everything else that is not local is a device route, and the local
  // device routes are the three the Phone tab registers through.
  for (const route of BRIDGE_ALLOWED_ROUTES) {
    if (route.path === "/api/health" || route.path === "/api/pair") continue;
    if (route.local === false) assert.equal(route.requiresDevice, true, `${route.method} ${route.path}`);
  }
  assert.equal(bridgeLocalRouteRequiresDevice("POST", "/api/companion/push-token"), true);
  assert.equal(bridgeLocalRouteRequiresDevice("POST", "/api/companion/live-activity-token"), true);
  assert.equal(bridgeLocalRouteRequiresDevice("GET", "/api/companion/push-health"), true);
  assert.equal(bridgeLocalRouteRequiresDevice("GET", "/api/companion/devices"), false);
  assert.equal(bridgeLocalRouteRequiresDevice("POST", "/api/companion/pairing/redeem"), false);
  assert.equal(bridgeLocalRouteRequiresDevice("POST", "/api/pair"), false);
});

test("every companion route the Phone tab needs is on the bridge", () => {
  for (const [method, url, local] of [
    ["GET", "/api/companion/endpoints", true],
    ["POST", "/api/pair", true],
    ["POST", "/api/companion/pairing/open", true],
    ["POST", "/api/companion/pairing/redeem", true],
    ["GET", "/api/companion/devices", true],
    ["DELETE", "/api/companion/devices/d-1", true],
    ["POST", "/api/companion/push-token", true],
    ["POST", "/api/companion/live-activity-token", true],
    ["GET", "/api/companion/push-health", true],
    ["GET", "/api/health", false],
    ["GET", "/api/bots", false],
    ["GET", "/api/threads/t-1/messages", false],
    ["POST", "/api/threads/t-1/respond", false],
    ["POST", "/api/bots/b-1/interrupt", false],
    ["GET", "/api/events", false],
  ]) {
    const decision = bridgeRouteDecision(method, url);
    assert.equal(decision.ok, true, `${method} ${url}`);
    assert.equal(decision.local, local, `${method} ${url} locality`);
  }
});

test("routes no shipped client calls are not forwarded, dead or not", () => {
  // The bridge's first table named these four. The iOS app calls none of
  // them against a server, and the harness serves none of them, so each one
  // was a door to a route that did not exist yet: a later harness release
  // would have opened it to every paired phone without anyone deciding.
  // Each is refused. Three are unknown paths, and the fourth shares its path
  // with the transcript read, so it answers 405 as any wrong method does.
  for (const [method, url, status] of [
    ["GET", "/api/fleet", 404],
    ["GET", "/api/threads/t-1", 404],
    ["POST", "/api/threads/t-1/messages", 405],
    ["POST", "/api/threads/t-1/interrupt", 404],
  ]) {
    const decision = bridgeRouteDecision(method, url);
    assert.equal(decision.ok, false, `${method} ${url}`);
    assert.equal(decision.status, status, `${method} ${url}`);
  }
  // What the app does call on those shapes is forwarded instead.
  assert.equal(bridgeRouteDecision("GET", "/api/threads/t-1/messages").ok, true);
  assert.equal(bridgeRouteDecision("POST", "/api/threads/t-1/respond").ok, true);
  assert.equal(bridgeRouteDecision("POST", "/api/bots/b-1/messages").ok, true);
  assert.equal(bridgeRouteDecision("POST", "/api/bots/b-1/interrupt").ok, true);
});

test("unknown paths, wrong methods, and traversal are refused", () => {
  assert.equal(bridgeRouteDecision("GET", "/api/admin").ok, false);
  assert.equal(bridgeRouteDecision("GET", "/api/admin").status, 404);
  const wrongMethod = bridgeRouteDecision("PUT", "/api/bots");
  assert.equal(wrongMethod.ok, false);
  assert.equal(wrongMethod.status, 405);
  // A method on a route another method owns is a 405, and it is the same
  // answer whether or not the caller may use either.
  assert.equal(bridgeRouteDecision("POST", "/api/config").status, 405);
  assert.equal(bridgeRouteDecision("GET", "/api/companion/pairing/redeem").status, 405);
  assert.equal(bridgeRouteDecision("GET", "/api/bots/../config").status, 404);
  assert.equal(bridgeRouteDecision("GET", "/api/bots//messages").status, 404);
  assert.equal(bridgeRouteDecision("GET", "/api/bots/b-1/messages/extra").status, 404);
  // Families the sidecar keeps off the phone stay off it here, under every
  // method: webhooks and triggers, the local VM, teams, the bare
  // per-connector delete, always-allow, the owner's runtime routes, and the
  // internal peer endpoints.
  for (const url of [
    "/api/webhooks",
    "/api/webhooks/wh-1",
    "/api/resource-triggers",
    "/api/local-computer",
    "/api/teams",
    "/api/connectors/github",
    "/api/bots/b-1/always-allow",
    "/api/runtime",
    "/api/runtime/quiesce",
    "/api/internal/peers",
    "/api/config/api-key/minimax",
    "/api/devices",
  ]) {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(bridgeRouteDecision(method, url).ok, false, `${method} ${url}`);
    }
  }
  // The computer-defaults route is the sidecar's one overlap, and the bridge
  // behaves the same way. The harness serves it as a POST only, so the POST
  // is refused (405, because sibling rows own the path), while a PATCH or a
  // DELETE reads `apply-defaults` as a bot id exactly as the sidecar's own
  // patterns do, and the harness answers that there is no such bot.
  const computerDefaults = bridgeRouteDecision("POST", "/api/bots/apply-defaults");
  assert.equal(computerDefaults.ok, false);
  assert.equal(computerDefaults.status, 405);
  assert.equal(bridgeBodyCheck("PATCH", "/api/bots/apply-defaults"), bridgeBotOrganizeDenial);
});

test("percent-encoded dot and slash forms are refused as traversal", () => {
  for (const url of [
    "/api/bots/%2e/config",
    "/api/bots/%2E%2E/config",
    "/api/bots/%252e/config",
    "/api/bots/a%2fb/messages",
    "/api/bots/%c0%af/messages",
    "/api/companion/devices/%2e",
  ]) {
    assert.equal(bridgeRouteDecision("GET", url).status, 404, url);
  }
  // A double-encoded dot is a closed door too. The sidecar matches its
  // patterns on the undecoded path, so an id carrying a per cent sign never
  // matches at all, here as there.
  assert.equal(bridgeRouteDecision("GET", "/api/bots/%252e").status, 404);
});

test("matching strips the query but the upstream keeps it byte for byte", () => {
  const decision = bridgeRouteDecision("GET", "/api/events?since=%3Ccursor%3A42%3E&tail=1");
  assert.equal(decision.ok, true);
  assert.equal(decision.upstream, "/api/events?since=%3Ccursor%3A42%3E&tail=1");
  const device = bridgeRouteDecision("DELETE", "/api/companion/devices/d-1?x=1");
  assert.equal(device.upstream, "/api/companion/devices/d-1?x=1");
  const page = bridgeRouteDecision("GET", "/api/threads/t-1/messages?limit=50&before=m-1%3A2&around=a$b");
  assert.equal(page.upstream, "/api/threads/t-1/messages?limit=50&before=m-1%3A2&around=a$b");
  const search = bridgeRouteDecision("GET", "/api/search?q=a%20b%2Bc&limit=40");
  assert.equal(search.upstream, "/api/search?q=a%20b%2Bc&limit=40");
});

test("a $-sequence in a path or a query is passed verbatim, not expanded", () => {
  const decision = bridgeRouteDecision("GET", "/api/events?since=$&$1$`$'");
  assert.equal(decision.ok, true);
  assert.equal(decision.upstream, "/api/events?since=$&$1$`$'");
  const quote = bridgeRouteDecision("DELETE", "/api/companion/devices/$'");
  assert.equal(quote.ok, true);
  assert.equal(quote.upstream, "/api/companion/devices/$'");
  const ampersand = bridgeRouteDecision("DELETE", "/api/companion/devices/$&");
  assert.equal(ampersand.ok, true);
  assert.equal(ampersand.upstream, "/api/companion/devices/$&");
});

test("the case-insensitive attachment row keeps the name's case on the way through", () => {
  const upper = bridgeRouteDecision("GET", "/api/attachments/Photo-1.PNG");
  assert.equal(upper.ok, true);
  assert.equal(upper.upstream, "/api/attachments/Photo-1.PNG");
  // and it is still one bare filename with an image extension, never a path
  for (const url of [
    "/api/attachments/Photo-1.PNG/extra",
    "/api/attachments/Photo-1.svg",
    "/api/attachments/Photo-1.png%2F..%2Fconfig.json",
    "/api/attachments/../config",
  ]) {
    assert.equal(bridgeRouteDecision("GET", url).status, 404, url);
  }
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

test("a metadata key whose value is absent stays absent and spends no kept slot", () => {
  // An absent value is not a key of the window, and it does not take one of
  // the eight kept slots either, so eight real values still fit beside it.
  const window = { ...openWindow(), empty: undefined, a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
  const decision = redeem(window, PROOF, { requestId: "pair-request-00000001", replayDeviceId: "d-9" });
  assert.equal(decision.ok, true);
  assert.ok(!("empty" in decision.window), "an absent value is not a key of the window");
  for (const key of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    assert.ok(key in decision.window, `${key} survives beside the absent value`);
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

test("push token validation and Live Activity payload match iOS ActivityKit expectations", () => {
  assert.equal(validateBridgePushToken("  " + "A".repeat(64) + " "), "a".repeat(64));
  assert.equal(validateBridgePushToken("short"), null);
  assert.equal(validateBridgePushToken("z".repeat(64)), null);
  assert.equal(validateBridgePushToken(12345), null);
  assert.equal(liveActivityTopic("app.botfleet.ios"), "app.botfleet.ios.push-type.liveactivity");

  const content = buildBridgeLiveActivityContent({
    title: "Forge",
    body: "Allow edit?",
    kind: "approval",
    threadId: "t-1",
    botId: "b-1",
    requestId: "req-1",
    color: "blue",
  }, 1_700_000_000_000);
  assert.ok(content);
  assert.equal(content.attributes.botId, "b-1");
  assert.equal(content.state.kind, "needsYou");
  assert.deepEqual(content.state.options, ["Allow", "Deny"]);
  const startPayload = buildBridgeLiveActivityPayload({
    event: "start",
    attributes: content.attributes,
    state: content.state,
    alert: content.alert,
    timestamp: 1_700_000_000,
  });
  assert.equal(startPayload.aps["attributes-type"], "BotActivityAttributes");
  assert.equal(startPayload.aps.event, "start");
  assert.equal(startPayload.aps["content-state"].requestId, "req-1");
});

test("a profile body may carry only the fields the sidecar allows a phone", () => {
  // The harness's bot editor accepts every one of these, and none of them
  // is a phone's to write: a bot's own MCP servers and their credentials,
  // its connected-app settings, its cloud backend, extra working folders.
  for (const field of [
    "ownMcpServers",
    "mcpServers",
    "composio",
    "connectorTools",
    "cloudBackend",
    "autoStartVps",
    "extraCwds",
    "userNotes",
    "maxHistoryTurns",
    "historySummaryModel",
    "alwaysAllow",
    "effort",
  ]) {
    const denial = bridgeProfilePatchDenial({ name: "Rio", [field]: {} });
    assert.equal(denial.status, 403, field);
    assert.equal(denial.error, `${field} can only be changed in BotFleet on your computer`, field);
  }
  // Every field on the list passes, alone and together.
  const body = {};
  for (const field of BRIDGE_PROFILE_PATCH_FIELDS) body[field] = null;
  assert.equal(bridgeProfilePatchDenial(body), null);
  assert.equal(bridgeProfilePatchDenial({}), null);
  // The whole request is refused, never trimmed: a field the person expected
  // to save is not silently dropped.
  assert.equal(bridgeProfilePatchDenial({ name: "Rio", ownMcpServers: {} }).status, 403);
  // A body that is not a JSON object is refused before any key is read.
  for (const bad of [[], "name", 3, null, undefined]) {
    assert.deepEqual(bridgeProfilePatchDenial(bad), { status: 400, error: "body must be a JSON object" });
  }
});

test("an organize body may carry the six roster fields and nothing else", () => {
  assert.deepEqual(bridgeBotOrganizeDenial({}), { status: 400, error: "nothing to save" });
  assert.equal(bridgeBotOrganizeDenial({ hidden: true, section: "Work", pinnedMessageId: "m-1" }), null);
  assert.equal(bridgeBotOrganizeDenial({ section: null, pinnedMessageId: null, chiefOfStaff: false }), null);
  assert.equal(bridgeBotOrganizeDenial({ pinnedMessageId: "" }), null);
  // Execution policy, computer grants and the persona fields never pass.
  for (const field of ["autoApprove", "bypassPermissions", "computers", "cwd", "name", "color", "off"]) {
    assert.deepEqual(bridgeBotOrganizeDenial({ hidden: true, [field]: true }), {
      status: 403,
      error: `${field} can only be changed in BotFleet on your computer`,
    });
  }
  // The harness stores four of these as sent, so the types are checked too.
  for (const field of ["hidden", "pinned", "unread", "chiefOfStaff"]) {
    assert.deepEqual(bridgeBotOrganizeDenial({ [field]: "yes" }), { status: 400, error: `${field} must be true or false` });
    assert.deepEqual(bridgeBotOrganizeDenial({ [field]: 1 }), { status: 400, error: `${field} must be true or false` });
  }
  assert.deepEqual(bridgeBotOrganizeDenial({ section: 7 }), { status: 400, error: "section must be a string or null" });
  assert.deepEqual(bridgeBotOrganizeDenial({ section: true }), { status: 400, error: "section must be a string or null" });
  assert.deepEqual(bridgeBotOrganizeDenial({ pinnedMessageId: "m 1" }), {
    status: 400,
    error: "pinnedMessageId must be a message id or null",
  });
  assert.deepEqual(bridgeBotOrganizeDenial({ pinnedMessageId: "../m-1" }), {
    status: 400,
    error: "pinnedMessageId must be a message id or null",
  });
  assert.deepEqual(bridgeBotOrganizeDenial({ pinnedMessageId: 5 }), {
    status: 400,
    error: "pinnedMessageId must be a message id or null",
  });
  for (const bad of [[], "hidden", null, undefined]) {
    assert.deepEqual(bridgeBotOrganizeDenial(bad), { status: 400, error: "body must be a JSON object" });
  }
});

test("the body check is attached to its two routes and to nothing else", () => {
  assert.equal(bridgeBodyCheck("PATCH", "/api/bots/b-1/profile"), bridgeProfilePatchDenial);
  assert.equal(bridgeBodyCheck("PATCH", "/api/bots/b-1"), bridgeBotOrganizeDenial);
  for (const [method, path] of [
    ["PATCH", "/api/groups/g-1"],
    ["PATCH", "/api/profile"],
    ["PATCH", "/api/bots/b-1/tasks/t-1"],
    ["PATCH", "/api/bots/b-1/skills/s-1"],
    ["PATCH", "/api/config"],
    ["POST", "/api/bots/b-1"],
    ["DELETE", "/api/bots/b-1"],
    ["PUT", "/api/bots/b-1/profile"],
    ["POST", "/api/bots/apply-model-defaults"],
    // An encoded id never reaches a check, because it never reaches a route.
    ["PATCH", "/api/bots/b%2D1"],
  ]) {
    assert.equal(bridgeBodyCheck(method, path), null, `${method} ${path}`);
  }
  // The check follows the path pattern, as it does on the sidecar, so a
  // PATCH that names a literal in the id position is held to the six fields.
  assert.equal(bridgeBodyCheck("PATCH", "/api/bots/apply-model-defaults"), bridgeBotOrganizeDenial);
});

test("the scrubber removes the withheld keys wherever they are nested, and nothing else", () => {
  const bot = {
    id: "b1",
    name: "Rio",
    resumeCursors: { ghost: "session-abc" },
    tasks: [
      { threadId: "t1", title: "One", resumeCursors: { ghost: "session-def" } },
      { threadId: "t2", title: "Two" },
    ],
  };
  const cleaned = bridgeScrub({ bots: [bot], groups: [] });
  assert.equal(JSON.stringify(cleaned).includes("resumeCursors"), false);
  assert.equal(JSON.stringify(cleaned).includes("session-abc"), false);
  assert.equal(JSON.stringify(cleaned).includes("session-def"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(cleaned)), {
    bots: [{ id: "b1", name: "Rio", tasks: [{ threadId: "t1", title: "One" }, { threadId: "t2", title: "Two" }] }],
    groups: [],
  });
  // The VPS host label goes and the configured signal stays: that is all the
  // phone renders.
  const status = { box: { configured: false }, vps: { configured: true, sshAlias: "prod-vps" } };
  const cleanedStatus = JSON.parse(JSON.stringify(bridgeScrub(status)));
  assert.deepEqual(cleanedStatus, { box: { configured: false }, vps: { configured: true } });
  // A value that is not a key is left alone.
  assert.equal(bridgeScrub(null), null);
  assert.equal(bridgeScrub(42), 42);
  assert.equal(bridgeScrub("resumeCursors"), "resumeCursors");
  assert.deepEqual(bridgeScrub([1, [2, [3]]]), [1, [2, [3]]]);
  // The input is not mutated.
  assert.deepEqual(status.vps, { configured: true, sshAlias: "prod-vps" });
});

test("a payload that names no withheld key comes back as the exact string, not a re-serialization", () => {
  // Spacing, key order and number spelling all survive, which proves the
  // text was never parsed and written back.
  const spaced = '{ "bots" : [ { "id" : "b1" , "n" : 1.0 } ] }';
  assert.equal(bridgeScrubWireJson(spaced), spaced);
  assert.equal(bridgeScrubWireJson('{"a":"a resume cursor is not a key"}'), '{"a":"a resume cursor is not a key"}');
  assert.equal(bridgeScrubWireJson(""), "");
  // Where it is named, the key goes and the rest is re-serialized.
  assert.equal(bridgeScrubWireJson('{ "vps" : { "configured" : true , "sshAlias" : "prod-vps" } }'), '{"vps":{"configured":true}}');
  assert.equal(bridgeScrubWireJson('{"tasks":[{"resumeCursors":{"g":"s"}}]}'), '{"tasks":[{}]}');
});

test("a payload that is not JSON passes, and one that cannot be scrubbed throws instead of passing", () => {
  assert.equal(bridgeScrubWireJson("not json at all sshAlias"), "not json at all sshAlias");
  // `JSON.parse` handles a depth the recursive scrubber cannot. Forwarding
  // that body would send exactly the key the scrubber exists to withhold, so
  // the failure is loud and the caller ends the response.
  const depth = 20_000;
  const deep = `${"[".repeat(depth)}{"sshAlias":"prod-vps"}${"]".repeat(depth)}`;
  assert.doesNotThrow(() => JSON.parse(deep));
  assert.throws(() => bridgeScrubWireJson(deep), RangeError);
  // and the same depth with no withheld key is forwarded untouched
  const clean = `${"[".repeat(depth)}1${"]".repeat(depth)}`;
  assert.equal(bridgeScrubWireJson(clean), clean);
});

test("a payload key spelled like the prototype accessor cannot change the scrubber's output", () => {
  const parsed = JSON.parse('{"sshAlias":"prod-vps","__proto__":{"polluted":true},"a":1}');
  const out = JSON.stringify(bridgeScrub(parsed));
  assert.equal(out, '{"__proto__":{"polluted":true},"a":1}');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(bridgeScrub(parsed)), null);
});

test("only real JSON content types are read for their keys", () => {
  assert.equal(bridgeIsJson("application/json"), true);
  assert.equal(bridgeIsJson("application/json; charset=utf-8"), true);
  assert.equal(bridgeIsJson("APPLICATION/JSON"), true);
  assert.equal(bridgeIsJson("image/png"), false);
  assert.equal(bridgeIsJson("text/event-stream"), false);
  assert.equal(bridgeIsJson(undefined), false);
  assert.equal(bridgeIsJson(""), false);
  // The structured suffix is the registered way to say "JSON underneath",
  // and one error answered that way would otherwise skip the scrubber.
  assert.equal(bridgeIsJson("application/problem+json"), true);
  assert.equal(bridgeIsJson("application/vnd.botfleet.bot+json; charset=utf-8"), true);
  assert.equal(bridgeIsJson("APPLICATION/PROBLEM+JSON"), true);
  assert.equal(bridgeIsJson("text/notjson"), false);
  assert.equal(bridgeIsJson("text/x-json"), false);
});

test("the SSE scrubber keeps the blank-line terminator that ends an event", () => {
  // The failure this guards against is silent: a stream that never
  // terminates an event parses to nothing while both ends look healthy.
  const out = createBridgeSseScrubber()('data: {"kind":"hello"}\n\n');
  assert.equal(out, 'data: {"kind":"hello"}\n\n');
  assert.equal(out.endsWith("\n\n"), true);
});

test("the SSE scrubber scrubs the payload but never the id: line", () => {
  const frame = 'id: abc123:7\ndata: {"kind":"bot","bot":{"id":"b1","resumeCursors":{"g":"s"}}}\n\n';
  const out = createBridgeSseScrubber()(frame);
  assert.ok(out.startsWith("id: abc123:7\n"));
  assert.equal(out.includes("resumeCursors"), false);
  assert.equal(out.includes('"g":"s"'), false);
  assert.equal(out, 'id: abc123:7\ndata: {"kind":"bot","bot":{"id":"b1"}}\n\n');
});

test("an SSE event that names no withheld key is returned as the exact bytes that arrived", () => {
  // No space after the colon, two events, a comment and an id: line all
  // cross unchanged, so an ordinary frame is byte for byte what the harness
  // wrote and the `id:` cursor is never rewritten.
  const stream = 'id: a:1\ndata:{"kind":"bot","bot":{"id":"b1"}}\n\n: keepalive\n\nid: a:2\ndata: {"kind":"message"}\n\n';
  assert.equal(createBridgeSseScrubber()(stream), stream);
});

test("the SSE scrubber emits an event as soon as it is complete, not when the chunk ends", () => {
  const scrubStream = createBridgeSseScrubber();
  // one event split across three arbitrary chunk boundaries
  assert.equal(scrubStream('id: a:1\nda'), "");
  assert.equal(scrubStream('ta: {"kind":"bot","resumeCursors":{"g":"s"}}'), "");
  assert.equal(scrubStream("\n\nid: a:2\n"), 'id: a:1\ndata: {"kind":"bot"}\n\n');
  // the second event is still incomplete and correctly withheld
  assert.equal(scrubStream('data: {"kind":"message"}\n\n'), 'id: a:2\ndata: {"kind":"message"}\n\n');
});

test("the SSE scrubber passes keepalive comments and unparseable data through untouched", () => {
  const scrubStream = createBridgeSseScrubber();
  assert.equal(scrubStream(": keepalive\n\n"), ": keepalive\n\n");
  assert.equal(scrubStream("data: not json at all\n\n"), "data: not json at all\n\n");
  // The harness's own keepalive, the one it writes every 25 seconds.
  assert.equal(scrubStream(": keepalive\n\n"), ": keepalive\n\n");
});

test("the SSE scrubber refuses to buffer an event that never terminates", () => {
  // "Buffer to the frame boundary" is bounded only by the sender behaving.
  const scrubStream = createBridgeSseScrubber();
  const chunk = "x".repeat(256 * 1024);
  let sent = 0;
  assert.throws(
    () => {
      for (;;) {
        scrubStream(chunk);
        sent += chunk.length;
        if (sent > MAX_BRIDGE_SSE_EVENT_BYTES * 2) throw new Error("buffered without limit");
      }
    },
    /without a terminator/,
  );
  assert.ok(sent <= MAX_BRIDGE_SSE_EVENT_BYTES + 4 * 256 * 1024, "the ceiling is the event cap, not twice it");
});

test("the SSE scrubber does not drop a large but well-formed event", () => {
  // The cap must sit clear of anything real, or a big-but-legitimate frame
  // would vanish and look exactly like a bug in the harness.
  const big = JSON.stringify({ kind: "bot", blob: "y".repeat(200 * 1024) });
  const out = createBridgeSseScrubber()(`data: ${big}\n\n`);
  assert.equal(out, `data: ${big}\n\n`);
});

test("the SSE scrubber handles several events arriving in one chunk", () => {
  const out = createBridgeSseScrubber()('id: a:1\ndata: {"a":1,"resumeCursors":{}}\n\nid: a:2\ndata: {"b":2}\n\n');
  assert.equal(out, 'id: a:1\ndata: {"a":1}\n\nid: a:2\ndata: {"b":2}\n\n');
});

test("the SSE scrubber terminates CRLF events and keeps them CRLF", () => {
  // A CRLF producer is legal SSE, and an LF-only scrubber buffers the whole
  // stream waiting for a boundary that never comes.
  const out = createBridgeSseScrubber()('id: a:1\r\ndata: {"a":1,"resumeCursors":{"g":"s"}}\r\n\r\n');
  assert.equal(out, 'id: a:1\r\ndata: {"a":1}\r\n\r\n');
  assert.equal(out.includes("resumeCursors"), false);
});

test("the SSE scrubber splits a CRLF stream across chunks without cutting an event short", () => {
  const scrubStream = createBridgeSseScrubber();
  // the chunk ends inside the terminator itself, the boundary a naive
  // indexOf gets wrong
  assert.equal(scrubStream('id: a:1\r\ndata: {"a":1}\r\n\r'), "");
  assert.equal(
    scrubStream('\nid: a:2\r\ndata: {"b":2}\r\n\r\n'),
    'id: a:1\r\ndata: {"a":1}\r\n\r\nid: a:2\r\ndata: {"b":2}\r\n\r\n',
  );
});

test("the SSE scrubber still handles a bare CR, which the spec also allows", () => {
  assert.equal(createBridgeSseScrubber()('data: {"a":1,"resumeCursors":{}}\r\r'), 'data: {"a":1}\r\r');
});

test("the configured advertisement is read as clean origins, first entry first", () => {
  const parsed = bridgeParseOrigins("https://Box.Example.ts.net:8800, http://box.example.ts.net:8080 , https://cdn.example");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.origins, [
    "https://box.example.ts.net:8800",
    "http://box.example.ts.net:8080",
    "https://cdn.example",
  ]);
  assert.deepEqual(
    bridgeEndpoints(parsed.origins),
    [
      // `tailscale serve --https` publishes the tailnet route as https, and
      // the shipped decoder accepts exactly one kind for an https URL.
      { url: "https://box.example.ts.net:8800", kind: "hosted", priority: 0 },
      { url: "http://box.example.ts.net:8080", kind: "tailnet", priority: 100 },
      { url: "https://cdn.example", kind: "hosted", priority: 200 },
    ],
  );
  // An absent or blank value is no advertisement, and not an error.
  assert.deepEqual(bridgeParseOrigins(undefined), { ok: true, origins: [] });
  assert.deepEqual(bridgeParseOrigins(""), { ok: true, origins: [] });
  assert.deepEqual(bridgeParseOrigins(" , "), { ok: true, origins: [] });
  // A duplicate costs nothing, and a default port is dropped as the phone
  // drops it.
  assert.deepEqual(bridgeParseOrigins("https://a.example, https://A.example/, https://b.example:443"), {
    ok: true,
    origins: ["https://a.example", "https://b.example"],
  });
});

test("an advertisement entry that is not a clean origin is refused by name and never skipped", () => {
  // A skipped entry is a route the owner believes is advertised and is not.
  for (const bad of [
    "a.example",
    "https://a.example/path",
    "https://a.example/deep/path",
    "https://user:secret@a.example",
    "https://a.example?x=1",
    "https://a.example#fragment",
    "ftp://a.example",
    "file:///tmp",
    "https://127.0.0.1:8800",
    "https://127.53.1.9",
    "https://localhost:8800",
    "https://bridge.localhost",
    "http://[::1]:8800",
    "https://0.0.0.0",
    "http://169.254.10.20:8800",
    "https://a.example:99999",
    "https://a b.example",
  ]) {
    const parsed = bridgeParseOrigins(`https://a.example, ${bad}`);
    assert.equal(parsed.ok, false, bad);
    assert.equal(Object.prototype.toString.call(parsed.reason), "[object String]");
    // The refusal names the rule, never the value.
    assert.equal(parsed.reason.includes(bad), false, bad);
  }
  // A trailing slash is the same origin with no path, so it is accepted.
  assert.deepEqual(bridgeParseOrigins("https://a.example:8800/"), { ok: true, origins: ["https://a.example:8800"] });
  // and the cap
  const hosts = Array.from({ length: BRIDGE_MAX_ENDPOINTS }, (_, index) => `https://h${index}.example`);
  assert.equal(bridgeParseOrigins(hosts.join(",")).ok, true);
  assert.equal(bridgeParseOrigins([...hosts, "https://h-over.example"].join(",")).ok, false);
  assert.equal(bridgeEndpoints([...hosts, "https://h-over.example"]).length, BRIDGE_MAX_ENDPOINTS);
});

test("the endpoint kind is the one the shipped decoder accepts for the scheme", () => {
  assert.equal(bridgeEndpointKind("https://box.example.ts.net:8800"), "hosted");
  assert.equal(bridgeEndpointKind("https://cdn.example"), "hosted");
  assert.equal(bridgeEndpointKind("http://box.example.ts.net:8080"), "tailnet");
  assert.equal(bridgeEndpointKind("http://box.example.ts.net."), "tailnet");
  assert.equal(bridgeEndpointKind("http://ts.net"), "lan");
  assert.equal(bridgeEndpointKind("http://192.168.1.20:8797"), "lan");
  assert.equal(bridgeEndpointKind("http://box.local:8797"), "lan");
  assert.equal(bridgeEndpointKind("ftp://box.example"), "");
  assert.equal(bridgeEndpointKind("not a url"), "");
  assert.equal(bridgeEndpointKind(undefined), "");
});

test("the advertisement holds at most eight routes and skips what is not a route", () => {
  const endpoints = bridgeEndpoints([
    "https://a.example",
    "not a url",
    "https://a.example",
    "https://127.0.0.1",
    "https://a.example/path",
    ...Array.from({ length: 9 }, (_, index) => `https://h${index}.example`),
  ]);
  assert.equal(endpoints.length, BRIDGE_MAX_ENDPOINTS);
  assert.deepEqual(
    endpoints.map((entry) => entry.priority),
    Array.from({ length: BRIDGE_MAX_ENDPOINTS }, (_, index) => index * 100),
  );
  assert.equal(new Set(endpoints.map((entry) => entry.url)).size, BRIDGE_MAX_ENDPOINTS);
  assert.deepEqual(endpoints[0], { url: "https://a.example", kind: "hosted", priority: 0 });
  for (const entry of endpoints) {
    assert.deepEqual(Object.keys(entry).sort(), ["kind", "priority", "url"]);
    assert.ok(entry.priority >= 0 && entry.priority <= 1_000_000);
  }
  assert.deepEqual(bridgeEndpoints(undefined), []);
  assert.deepEqual(bridgeEndpoints("https://a.example"), []);
  assert.deepEqual(bridgeCleanOrigin("https://a.example"), "https://a.example");
  assert.equal(BRIDGE_SERVER_NAME.length > 0, true);
});

test("a device name from the phone is display text and nothing more", () => {
  assert.equal(bridgeCleanDeviceName("  Jay\u0027s\u001fiPhone\u0007 \n"), "Jay's iPhone");
  assert.equal(bridgeCleanDeviceName("x".repeat(80)).length, 60);
  assert.equal(bridgeCleanDeviceName("   "), "Companion");
  assert.equal(bridgeCleanDeviceName(undefined), "Companion");
  assert.equal(bridgeCleanDeviceName(42), "42");
  // A long name with control characters is cleaned before it is cut.
  assert.equal(bridgeCleanDeviceName("\u0000" + "y".repeat(70)), "y".repeat(60));
});

test("every pairing refusal the core can name has a sentence for the person", () => {
  const sentences = new Set();
  for (const reason of [
    "no pairing window is open",
    "window expired",
    "window already spent",
    "no attempts left",
    "bad credential",
    "the device limit is reached",
  ]) {
    const sentence = bridgePairRefusalSentence(reason);
    assert.equal(Object.prototype.toString.call(sentence), "[object String]", reason);
    assert.ok(sentence.endsWith("."), reason);
    assert.equal(sentence.includes(reason), false, `${reason} stays as wording for the log`);
    sentences.add(sentence);
  }
  // Each reason reads differently, so a person can tell what to do next.
  assert.equal(sentences.size, 6);
  // A reason this does not know gets the general sentence, not its wording.
  const unknown = bridgePairRefusalSentence("something new went wrong");
  assert.equal(unknown, "This server could not complete the pairing. Start pairing again.");
  assert.equal(bridgePairRefusalSentence(undefined), unknown);
});

test("a retried pairing is refused by name and never answers a body the app would store", () => {
  assert.equal(BRIDGE_PAIR_REPLAY_REFUSAL.status, 409);
  assert.match(BRIDGE_PAIR_REPLAY_REFUSAL.error, /issued only once/);
  assert.ok(Object.isFrozen(BRIDGE_PAIR_REPLAY_REFUSAL));
  // Nothing shaped like `PairResponse`: no token, so nothing to save.
  assert.equal("token" in BRIDGE_PAIR_REPLAY_REFUSAL, false);
  assert.equal("device" in BRIDGE_PAIR_REPLAY_REFUSAL, false);
  assert.equal("serverName" in BRIDGE_PAIR_REPLAY_REFUSAL, false);
});
