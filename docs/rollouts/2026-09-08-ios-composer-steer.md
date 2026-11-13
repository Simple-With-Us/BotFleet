# 2026-09-08 — iOS composer radius, Return, send bubble, Steer, in-thread banners

## Context & Objective

Owner on iOS: own message vanished after send; keyboard showed a blue send arrow; the typing field used a capsule so multi-line text ballooned into an oval; command and mic squeezed the field; wanted a Steer control; a banner fired while already in that thread.  Desktop composer placeholders should be italic so they do not look like typed text.

Board `e92b04b5`.  Branch `compiler/ios-composer`.  Worktree `~/apps/botfleet-compiler-composer`.  No TestFlight extra-ship.

## Changes Made

- Composer glass is a 18pt rounded rect, not a capsule.
- Keyboard submit label is Return.  Send is only the arrow button.
- Command and Dictate moved into the + menu.  Mic stays in the field only while listening, so you can stop it.
- Steer chip while the bot is working, plus a Steer row in the + menu.  Empty Steer sends the existing `/steer` prompt.
- Idle sends keep a pending user bubble until the matching `message` frame lands.  202 busy still promotes to the queued chip.
- Foreground banners skip the thread already on screen (SSE deliver and APNs `willPresent`).
- Desktop composer placeholder is italic.

Touched files:

- `ios/App/ChatView.swift`
- `ios/App/Glass.swift`
- `ios/App/Session.swift`
- `ios/App/Notifications.swift`
- `ios/Sources/CompanionCore/Store.swift`
- `ios/Sources/CompanionCore/Models.swift`
- `ios/Sources/CompanionCore/Frames.swift`
- `ios/Tests/CompanionCoreTests/StoreTests.swift`
- `ios/README.md`
- `src/components/Composer.tsx`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

Did not extra-ship TestFlight.  Pending own-sends are the one optimistic exception; everything else still waits on the harness.  Command/mic are in + rather than stacked above +, so the field stays wide.

## Verification State

```
cd ios && swift test
```
