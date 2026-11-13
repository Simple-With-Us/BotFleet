# 2026-09-12 — iOS Live Activity Suspension Policy

Issue #294.  Board `699ea1ae`.  Branch `codex/ios-live-activity-suspend-20260912`.

## Behavior

BotFleet uses local ActivityKit updates and does not register Live Activity push tokens.  Initial activation first clears any ActivityKit cards restored from the previous process.  When the app enters the background, it invalidates queued foreground updates, clears its activity snapshot, and requests immediate teardown of every BotFleet Live Activity.  Returning to the foreground creates a new lifecycle generation, keeps updates disabled while a guarded post-resume snapshot loads, and reconciles that fresh state only after teardown finishes.

The inactive phase keeps the current update policy because it also covers short system interruptions such as Control Center.  Only the background transition disables updates and starts teardown.

## Race Handling

ActivityKit mutations run through one ordered task chain.  Each foreground update carries the generation that scheduled it and rechecks that generation around suspension points.  A stale update therefore cannot recreate an activity after background teardown, while a rapid foreground return waits for both teardown and a post-resume snapshot before rebuilding.  Snapshot application uses the same pairing-generation and state-revision guards as other companion hydration paths; transient failures and stream-revision conflicts retry with a bounded 1, 2, 4, 8, then 15-second backoff while the app remains active.  Signing out ends activities immediately, and a new pairing in the same foreground session resets the generation and starts a fresh guarded hydration.

## Validation

- `cd ios && swift test` — 262 tests passed after integrating current main.
- Local unsigned app build remains blocked because Xcode reports that iOS 26.5 is not installed.  The SDK listing is present, but no eligible device or simulator runtime is installed; hosted unsigned compilation is required for the final head.
- Physical-device stale, update, end, tap, and relaunch acceptance remains open.  No paired device or production notification state was mutated.
