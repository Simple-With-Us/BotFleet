# 2026-09-22 — APNs HTTP/2 Transport Hardening

> Authors: original branch work by MM ([MINIMAX]); review-fix rounds by Instinct lanes.  Continuation of the
> 2026-09-20 MiniMax inspection; this pass finishes the APNs leg that
> surfaced as board `851f6868afc748d78ac2da02fa0541f9` (P2) and the
> "failed keeps climbing" symptom Jay flagged on 2026-09-22.

## Context

Jay reported on 2026-09-22 that the sidecar APNs health snapshot shows
`failed` climbing and `keyRejected` set even though the `.p8` key file
on disk has not changed.  The control page rendered Apple's `SendFailed`
as a status, but the underlying cause was never visible.  Two related
gaps drove the fix:

1. **HTTP/2 transport**.  Node 26's native `fetch` (undici) opens a
   fresh HTTP/2 session per request, sets no TCP keepalive, no HTTP/2
   PING keepalive, and reports `GOAWAY` / `RST_STREAM` as a generic
   "fetch failed".  Apple's APNs HTTP/2 reference explicitly asks
   long-lived senders to keep a persistent HTTP/2 session with PING
   keepalives.  The previous implementation did neither.
2. **Swallowed transport error**.  The `catch {}` block at
   `companion/src/apns.ts:364` (now replaced) silently dropped the
   underlying error, so the health page could not tell a DNS blip
   apart from an HTTP/2 GOAWAY from a socket reset.

## Root Cause

The sidecar was issuing one TLS handshake + one HTTP/2 session per
push.  Each handshake re-ran Apple's certificate chain validation;
every Wi-Fi blip looked like a fresh start; every GOAWAY was a black
box.  When the underlying network started failing in a tight loop the
sender burned CPU on doomed sends, ate provider-token re-signs at the
20-minute cadence, and reported `failed` climbing without anything
useful to do about it.

## What Shipped This Pass

Five interlocking fixes in `companion/src/apns.ts` + a UI surface on
the pairing page.

### 1.  Persistent HTTP/2 Session (`node:http2`)

Replaced the `fetchImpl`-based POST with a Node `http2` core-module
session that:

- holds one `client.connect` per `(host, keyId)`, keyed so a key
  rotation builds a fresh session;
- sets TCP keepalive (`keepAlive: true`, `keepAliveInitialDelay:
  30000` ms) and runs an HTTP/2 PING every 30s via `session.ping`
  (`pingIntervalMs: 30000`) per Apple's APNs HTTP/2 reference; a PING
  that fails or goes unanswered for `pingDeadlineMs` (10s) evicts and
  destroys the session and fails its pending sends;
- configures `settings.maxConcurrentStreams: 500`,
  `settings.initialWindowSize: 1 MiB`, `maxSessionMemory: 10` (MB);
- closes the session cleanly when no peer stream is open and rebuilds
  lazily after a GOAWAY.

The `fetchImpl` test seam is preserved: tests inject a fake fetch and
bypass the http2 path entirely.  No new dependencies — `node:http2`
is core.

### 2.  Real Transport Error Capture

The old `catch {}` swallowed everything.  `inspectTransportError` now
reads `err.name`, `err.code`, `err.message`, and `err.cause`, and
`classifyTransportError` maps those to one of:

| Bucket          | What trips it                                              |
|-----------------|------------------------------------------------------------|
| `transport`     | DNS / TCP / TLS handshake (`ENOTFOUND`, `ECONNREFUSED`, …) |
| `http2_protocol`| `ERR_HTTP2_*` — GOAWAY, RST_STREAM, INTERNAL_ERROR         |
| `socket_closed` | `ECONNRESET`, `EPIPE`                                      |
| `timeout`       | `ETIMEDOUT`, `ERR_HTTP2_PING_CANCEL`, `ERR_HTTP2_SESSION_EOF` |

The bucketed kind lands on `ApnsSendResult.failureKind` and
`PushSenderHealth.failureKind`; the verbatim `err.code` lands on
`errorCode` / `lastErrorCode` so the health page can name what
actually went wrong (`ECONNRESET` vs `ERR_HTTP2_PROTOCOL_ERROR`).

### 3.  Circuit Breaker

Twenty consecutive transport-or-socket failures, or five consecutive
HTTP/2 protocol errors, opens a 60-second circuit breaker.
`sendOne` short-circuits while the breaker is open, increments
`circuitDropped` (so it shows up on the health page apart from
queue-full `dropped`), and skips the network
round-trip.  This stops a hot loop from burning CPU and provider-token
re-signs against an unreachable gateway.  A single successful send
resets the run and closes the circuit.

Thresholds are exported as `APNS_CIRCUIT_WINDOW_MS` (60s),
`APNS_TRANSPORT_THRESHOLD` (20), `APNS_HTTP2_PROTOCOL_THRESHOLD` (5).

### 4.  Apple's `timestamp` Field on `InvalidProviderToken`

Apple's 403 `InvalidProviderToken` body carries a `timestamp` field
whose value the Apple debug page asks for verbatim.  The control page
now renders it as `InvalidProviderToken (timestamp=1700000000000)`
directly, so the owner does not have to dig through the log to file
a debug ticket.

### 5.  UI Surface on the Pairing Page

`companion/src/control.ts:426-445` now renders four extra paragraphs
when present:

- `lastErrorCode` next to `lastError`;
- `failureKind` plus the consecutive run count;
- a "pushes are paused until HH:MM:SS" line while the circuit is
  open;
- circuit-breaker skips (`circuitDropped`) on their own line, apart
  from the queue-full `dropped` line.

## Verification

```
$ cd ~/apps/botfleet-mm-apn-transport && pnpm typecheck
> tsc -b && tsc -p tsconfig.server.json
(clean)

$ cd ~/apps/botfleet-mm-apn-transport && pnpm exec vitest run companion/src/apns.test.ts
 Test Files  1 passed (1)
      Tests  69 passed (69)
```

Test additions in `companion/src/apns.test.ts`:

- `inspectTransportError` — reads all fields, falls back on
  non-object throws.
- `classifyTransportError` — `ECONNRESET` → `socket_closed`,
  `ERR_HTTP2_GOAWAY` → `http2_protocol`, `ENOTFOUND` → `transport`.
- `classifyHttpResponse` — `410`/`400 BadDeviceToken` → `bad_token`,
  `403 ExpiredProviderToken` → `expired_token`,
  `403 InvalidProviderToken` → `key_fault`, `429`/`503` →
  `rate_limit`, generic `500` → `server`.
- `sendApnsAlert` — `ECONNRESET` is captured as `socket_closed`
  with `errorCode: "ECONNRESET"`; `ERR_HTTP2_GOAWAY` becomes
  `http2_protocol`; a `403 InvalidProviderToken` body with
  `timestamp: 1700000000000` lands on `errorTimestamp`; a body
  without `timestamp` returns `errorTimestamp: undefined`.
- HTTP/2 session cache — same keyId reuses the session; a different
  keyId forces a rebuild.
- Circuit breaker — 30 transport failures queued for one phone open
  the circuit at 20 and skip the remaining 10 (`circuitDropped` ≥ 10,
  `dropped` = 0, `failed` = 20).
- Reset on success — a single successful send zeroes
  `consecutiveTransportFailures` and clears `circuitOpenUntil`.
- Timestamp on key fault — `health.lastError` renders
  `InvalidProviderToken (timestamp=1700000000000)`.

Existing tests at `apns.test.ts:281` (`InvalidProviderToken` does not
re-sign) and `:720` (key rejection stops sending) still pass without
modification; the typecheck surfaces every inline `PushSenderHealth`
literal, and the proxy test's inline response literal was updated to
include the new fields.

## Rollback Plan

A single `git revert` of the merge commit returns the sidecar to
native `fetch` with the old swallowed-error `catch {}`.  No
configuration or persisted state is touched — the session cache is
process-local and the new fields are additive on `PushSenderHealth`.

## Future Work

- **Load shedding when `tokensRegistered === 0`.**  Skip the http2
  connect entirely when no phone holds a push token.  Saves a
  socket-open on sidecars that never push (e.g. dev environments).
- **IPv6 fallback**.  Apple's APNs endpoint resolves both A and AAAA;
  Node's `http2.connect` is happy with either, but a hard `AF_INET6`
  hint would help on networks with broken NAT64.
- **`apns-priority: 5` for non-alert pushes.**  Currently every push
  carries `apns-priority: 10`; background-fetch-only pushes could
  drop to `5` to stay under Apple's per-device rate limit.
- **Per-host circuit on the production http2 path.**  The breaker
  today trips on the production host name; an IPv4/IPv6 split would
  let one transport recover while the other is broken.

## Resolves

- Board `851f6868afc748d78ac2da02fa0541f9` (P2 — APNs push: 1825
  SendFailed since 21:50, likely HTTP/2 transport issue).
- Board `d4499f2d` (P2 — APNs push transport follow-up).
