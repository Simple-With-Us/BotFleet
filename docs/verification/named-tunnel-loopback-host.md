# Named tunnel loopback Host (BF-2129)

Verifies how `https://botfleet.jays.services` reaches the harness on `127.0.0.1:8799` and what that implies for the loopback Host gate.

## Setup

The harness rejects non-loopback `Host` values before any route runs (`server/index.ts`, `isLoopbackHost`).  The named tunnel is Access-gated with `/api/health` left public (`docs/rollouts/2026-09-06-remote-access.md`).

## Evidence: tunnel presents loopback Host

**Command (safe — public health only, no auth paths):**

```sh
curl -sS https://botfleet.jays.services/api/health
```

**Expected output (2026-10-15):**

```json
{"app":"botfleet","pid":<number>,"static":false,"ready":true,"booting":false}
```

If the tunnel forwarded the public hostname as `Host`, the harness would answer `403` with `forbidden: loopback host required`.  A BotFleet health payload therefore proves the tunnel presents a loopback `Host` (typically `127.0.0.1:8799`).

## Harness mitigation (code)

Mutating `/api/*` requests that carry Cloudflare edge markers (`cf-ray`, `cf-connecting-ip`, `cf-access-jwt-assertion`, …) are refused with `forbidden: named tunnel cannot mutate the harness until remote auth lands`.  Local desktop, CLI, and companion replay traffic does not send those headers.

**Automated recipe:**

```sh
pnpm vitest run server/named-tunnel-gate.test.ts server/harness-trust-boundary.test.ts -t "named tunnel"
```

## Open follow-up

Read-only remote access and a real remote-auth seam (service token or Access JWT validation inside the harness) remain future work.  Changing cloudflared `httpHostHeader` on Jay's Mac is not required for the mutation block above.
