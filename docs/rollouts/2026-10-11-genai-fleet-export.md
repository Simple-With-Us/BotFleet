# Gen AI Fleet-Infra Export

## Summary

Completed BotFleet turns now send one gen_ai summary event to the shared
Sentry `fleet-infra` project when `SENTRY_FLEET_DSN` is set.  The product
`botfleet` project is unchanged.  No DSN is hardcoded.

## Why

The 2026-10-11 telemetry audit (C.5) asked BotFleet to export gen_ai turns
into fleet-infra so the fleet dashboard can see BotFleet next to the other
coding platforms.  The relay from task C.1 is not in this repo, so this
slice uses a second Sentry client keyed by Infisical `SENTRY_FLEET_DSN`.

## Files

- `server/sentry-fleet.ts` — DSN resolution and summary capture
- `server/secret-map.ts` — `observability.sentryFleetDsn` / `SENTRY_FLEET_DSN`
- `server/sentry-ai.ts` — export on turn settle
- `docs/observability.md` — documents the opt-in DSN

## Verification

```sh
pnpm exec vitest run server/sentry-fleet.test.ts server/sentry-ai.test.ts server/secret-map.test.ts server/config.test.ts
pnpm typecheck
```

## Jay secrets

Set `SENTRY_FLEET_DSN` in the BotFleet Infisical project, `env=prod`,
`path=/`.  The value is the fleet-infra project DSN.  Do not put it in
source, in `SENTRY_DSN`, or in a Settings field.
