# Sentry Release Hygiene

## Summary

Node and React Sentry clients now set `release` to a git SHA.
`@sentry/vite-plugin` uploads renderer source maps when CI has
`SENTRY_AUTH_TOKEN`.  Electron main initializes `@sentry/electron`.
`@sentry/profiling-node` is a real dependency so the existing attach path
can turn profiling on.

## Decisions

- Adopt a single git SHA as the release identifier across Node, React and
  Electron so `sentry-deploy.yml` markers line up with every SDK event.
- Gate `@sentry/vite-plugin` on `SENTRY_AUTH_TOKEN` so renderer source maps
  upload only when CI can authenticate; no DSN is written to source.
- Pull `@sentry/profiling-node` in as a real dependency so the existing
  attach path can switch profiling on without a missing-module error.
- Allow `@sentry/cli` and `@sentry/node-cpu-profiler` postinstall scripts in
  `pnpm-workspace.yaml` so pnpm 12 installs succeed in CI.

## Files

- `server/sentry.ts` — `sentryReleaseName`, `release` on `Sentry.init`
- `src/lib/sentry.ts` — `VITE_SENTRY_RELEASE` on the browser client
- `vite.config.ts` — `@sentry/vite-plugin`, gated on `SENTRY_AUTH_TOKEN`
- `electron/main.mjs` — `@sentry/electron/main`
- package jobs also resolve `SENTRY_AUTH_TOKEN`

## Verification

```sh
pnpm exec vitest run server/sentry.test.ts src/lib/sentry.test.ts -> ok
npm run build -> ok
pnpm typecheck -> ok
```

## Jay secrets

`SENTRY_AUTH_TOKEN` (project:releases) already exists for
`sentry-deploy.yml`.  Add the same name to BotFleet Infisical prod so
desktop package jobs can upload source maps.  No DSN belongs in source.
