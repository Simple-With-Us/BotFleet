# 2026-09-01 — Sentry client observability: Session Replay, error capture & distributed tracing (Antigravity, `ag/sentry-observability-expansion`)

## Summary
Integrated Sentry client observability into BotFleet (`simple-with-us/botfleet`):
- **@sentry/react client integration**: Initialized in `src/main.tsx` via `src/lib/sentry.ts`.
- **Session Replay enabled**: 100% capture on errors (`replaysOnErrorSampleRate: 1.0`) and 10% baseline session sampling (`replaysSessionSampleRate: 0.1`) with full privacy masking (`maskAllText: true`, `blockAllMedia: true`).
- **Distributed tracing**: Browser tracing enabled with baseline 0.2 sample rate.
- **Inert when unconfigured**: Completely inert in dev/CI when `VITE_SENTRY_DSN` is not provided.
- **Server Store cleanup**: Fixed TypeScript compilation in `server/store.ts` and updated companion route test.

## Verification
- `pnpm typecheck` — 0 errors.
- `pnpm test` (all 2,271 tests passing).
