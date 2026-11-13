# 2026-09-04 — Sentry Max Features (BotFleet)

Board `af1ab6e9`.  Branch `grok/sentry-max-features`.  Worktree
`~/apps/botfleet-grok-sentry-max`.

## Changes

- Node harness `profileSessionSampleRate` + optional `@sentry/profiling-node`.
- iOS profiling 0.1 + masked Session Replay (10% / 100% error).
- Web Feedback already on.  Windows SDK listed N/A (not a second project).
- **Seer Autofix ENABLE for BotFleet only.**  Sentry project
  `simple-with-us/botfleet`: `autofixAutomationTuning=always`,
  `seerScannerAutomation=true` (API PUT, 200).  Hold Autofix on other apps.
  Billing did not block (sponsored / $5k credit).

## Verification

- `pnpm exec vitest run src/lib/sentry.test.ts`
