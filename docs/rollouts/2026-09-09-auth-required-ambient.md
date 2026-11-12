# 2026-09-09 — Grok ACP ambient login; no Sentry Issue for setup stops

## Context & Objective

Sentry BOTFLEET-C (high) and sibling BOTFLEET-A: a webhook-triggered grokAgent turn settled `auth_required` with `runtime.error` "Grok CLI is not signed in" while `~/.grok/auth.json` existed (OIDC, not expired).  One occurrence, 0 users, handled.  Live health 200.  The ACP handshake fail-closes when initialize omits `cached_token` or `authenticate` rejects, ignoring snapshot auth.

## Changes Made

- `server/drivers/acp/core.ts`: `authFailure: "fail"` throws the login note only when `isAuthenticated` is false.  A signed-in CLI proceeds on ambient login.
- `server/drivers/acp/acp.test.ts`: fail-closed test isolates HOME without `auth.json`.  New test: `auth.json` present + no `cached_token` completes ok.
- `server/sentry-ai.ts`: `runtime.error` with `setup: true`, and `turn.completed` stop reasons `auth_required` / `cancelled`, become breadcrumbs, not Issues.

Touched files:

- `server/drivers/acp/core.ts`
- `server/drivers/acp/grok.ts`
- `server/drivers/acp/acp.test.ts`
- `server/sentry-ai.ts`
- `server/sentry-ai.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-09-auth-required-ambient.md`

## Decisions & Trade-offs

Did not rename grok's `pickAuthMethod` for OIDC method ids — ambient continue covers empty `authMethods` while signed in.  Did not scrub webhook secrets from Sentry transaction URLs (separate leak; extra-ship no).  Did not edit `~/apps/botfleet-server`.  Live harness needs `update-botfleet.sh`.  No TestFlight.

## Verification State

```
pnpm exec vitest run server/drivers/acp/acp.test.ts server/sentry-ai.test.ts
pnpm typecheck
```
