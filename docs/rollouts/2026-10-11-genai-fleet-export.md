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

## Business rules

- One event per completed bot turn.  An incomplete turn (no `turn.completed`
  seen) emits nothing; a turn that ends `ok=false` still emits, tagged
  `botfleet.ok=false` so failed runs are visible in fleet-infra.
- The product `SENTRY_DSN` (the `botfleet` project) is never reused as the
  fleet-infra DSN.  Setting `SENTRY_FLEET_DSN` to the product DSN is a
  configuration error and the harness treats the export as inert until the
  value is corrected.
- A missing `SENTRY_FLEET_DSN` is the default.  The export is inert, the
  status view reports `fleetExportConfigured: false`, and the rest of the
  harness is unaffected.  There is no shipped default DSN.
- The summary is metadata only: provider, model, token counts, catalog or
  reported cost, duration, tool names, and bot identity.  Prompts,
  transcripts, tool arguments, and webhook payloads are never sent.
- A failing fleet-infra SDK or a refused DSN must never fail a bot turn.
  `captureWithLiveClient` swallows every error path and the export is
  best-effort by design.

## Acceptance criteria

- `pnpm exec vitest run server/sentry-fleet.test.ts server/sentry-ai.test.ts server/secret-map.test.ts server/config.test.ts` passes.
- `pnpm typecheck` passes.
- With no DSN configured, `exportFleetTurn` is a no-op and
  `sentryFleetState()` returns `{ active: false, configured: false,
  host: null, projectId: null }`.
- With a valid DSN, exactly one summary event lands in fleet-infra per
  `turn.completed`, carrying `gen_ai.system`, `gen_ai.provider.name`,
  `gen_ai.conversation.id`, `botfleet.thread.id`, `botfleet.ok`, and (when
  known) `gen_ai.request.model`.
- Catalog-priced turns put the cost on `gen_ai.usage.cost`; subscription or
  other estimated turns route it to `botfleet.cost.estimated_usd` so the
  fleet dashboard does not conflate them.
- The DSN is resolved from Infisical first, then `SENTRY_FLEET_DSN`, then
  the stored `observability.sentryFleetDsn` setting, in that order, the
  same ordering as the product DSN.
- `server/sentry-fleet.ts` never loads `@sentry/node` under vitest; the
  test sink is installed by `setFleetSinkForTests` and replaced by
  `resetSentryFleetForTests`.

## Edge cases and constraints

- No DSN → export inert, harness boots, status view shows the export as
  unconfigured.  The product DSN path is independent.
- DSN set but unreachable → first capture is dropped (the live client is
  built lazily), subsequent captures still succeed once the SDK resolves;
  no turn is ever failed by telemetry.
- Mid-run DSN rotation → `applySentryFleetConfig` closes the prior
  `NodeClient` and rebuilds on the next capture so a rotated Infisical
  value takes effect without restarting the harness.
- Missing provider or model → `gen_ai.system` and `gen_ai.provider.name`
  carry the raw provider string; `gen_ai.request.model` is omitted when
  unknown, and the message falls back to `"unknown"`.
- Subscription / unknown-model cost → cost lands on
  `botfleet.cost.estimated_usd` and is omitted from `gen_ai.usage.cost` so
  the fleet dashboard does not bill it as catalog-priced.
- No tool calls → `botfleet.tool.count` is `0`, `botfleet.tool.names` is
  omitted, the event still emits.
- Vitest runs (`VITEST=true` or `NODE_ENV=test`) → the live client is
  suppressed; only the recording sink captures.  `@sentry/node` is loaded
  only in production.
- DSN never appears in logs, status JSON, or test assertions — the runtime
  state exposes only `host` and `projectId`, and the JSON-state assertion
  in `sentry-fleet.test.ts` enforces that.

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