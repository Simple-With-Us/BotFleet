# Sentry Release Hygiene

## Summary

Node and React Sentry clients now set `release` to a git SHA.
`@sentry/vite-plugin` uploads renderer source maps when CI has
`SENTRY_AUTH_TOKEN`.  Electron main initializes `@sentry/electron`.
`@sentry/profiling-node` is a real dependency so the existing attach path
can turn profiling on.

## Why

The 2026-10-11 telemetry audit (C.5) showed botfleet node/react events with
no release, so `sentry-deploy.yml` markers could not match.  Renderer
source maps were not uploaded.  Electron main and native crashes were
silent.  Profiling was coded but the package was missing.

## Files

- `server/sentry.ts` — `sentryReleaseName`, `release` on `Sentry.init`
- `src/lib/sentry.ts` — `VITE_SENTRY_RELEASE` on the browser client
- `vite.config.ts` — `@sentry/vite-plugin`, gated on `SENTRY_AUTH_TOKEN`
- `electron/main.mjs` — `@sentry/electron/main`
- package jobs also resolve `SENTRY_AUTH_TOKEN`

## Verification

```sh
pnpm exec vitest run server/sentry.test.ts src/lib/sentry.test.ts
node --test electron/sentry-desktop.node-test.mjs
pnpm typecheck
```

## Jay secrets

`SENTRY_AUTH_TOKEN` (project:releases) already exists for
`sentry-deploy.yml`.  Add the same name to BotFleet Infisical prod so
desktop package jobs can upload source maps.  No DSN belongs in source.
