# Server Companion Bridge: Locked Design (BF-2652)

Status: design plus isolated contract core (`Refs BF-2652`). Branch
`muse-code/bf2652-server-bridge`. No listener, no unit, no manifest entry,
no key binding, no live traffic: those land separately after review.

## Locked owner decisions (Jay, Nov 22)

Endpoint locus is the server; the server is the locus for all things. APNs
locus is therefore the Linux sender on a scoped read-only Infisical key.
Tailscale first for route/TLS, hosted HTTPS second. Default-off listener
and Node `:8810` sidecar retirement only after a real-phone end-to-end.

## What the bridge is

A restricted companion route on the Linux server beside `owner-gate.mjs`,
reusing its loopback plus owner-credential pattern: `tailscale serve`
terminates TLS in the tailnet, the bridge listens on loopback, and every
request carries an owner credential plus a per-route device credential.
Pairing windows, the device registry, and the advertisement are
bridge-local; no secret is shared with the Mac. The phone holds both
advertisements and prefers the bridge whenever placement is `serverFirst`.

## Route table

Served locally (own registry): `GET /api/companion/endpoints`,
`POST /api/companion/pairing/open`, `POST /api/companion/pairing/redeem`,
`GET /api/companion/devices`, `DELETE /api/companion/devices/:id`.
Proxied transparently to the same harness path: `GET /api/fleet`,
`GET /api/threads/:id`, `POST /api/threads/:id/messages`,
`POST /api/threads/:id/interrupt`, `GET /api/events` with cursor params
and headers passed through byte for byte, never rewritten.

## Auth, pairing, push

Device credentials are digests-only, compared timing-safe; malformed
registry entries are skipped, never trusted. Pairing windows open with a
6-digit code plus a high-entropy token and spend exactly once; wrong
credentials cost one attempt and the budget locks. One device never has
two senders: the server sends when it owns the current pairing, decided
at lookup time rather than raced at send time. Alert payloads mirror the
native provider's keys so a device sees one shape whichever side sends.

## What the core proves today

`deploy/linux-server/companion-bridge.mjs` holds the decision core as
pure helpers; `companion-bridge.node-test.mjs` pins it with 11 tests on
a fake clock and a fake registry — route allowlist and locality, 404 vs
405, traversal refusal, query byte-preservation, single-spend windows,
expiry, attempt budgets, digest-only device auth, the one-sender rule,
and the payload shape. Wired into `test:linux-server-install`.

## Packaging follow-ups (separate lane, after review)

Listener wiring behind the existing default-off posture, the systemd
unit, the `retained-source` manifest entry plus policy regeneration,
the scoped Infisical APNs key grant, and the Tailscale serve route.
Then the physical-iPhone verification recipe from the BF-2652 proposal.
