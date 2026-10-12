# 2026-10-11 — iOS Live Activity Approval From The Lock Screen

Issue BF-2410.  Branch `minimax/ios-live-activity-approval`.  Supersedes the
background half of [2026-09-12-ios-live-activity-suspension.md](2026-09-12-ios-live-activity-suspension.md);
its race handling, generation guards and refresh backoff are unchanged.

## Changes

One bullet per edited path.

- `ios/Sources/CompanionCore/LiveActivityLifecycle.swift` — `transition(to: .background)` now returns the new `.endAmbient` instead of `.endAll`; `.endAll` is kept for sign-out and cold resets.
- `ios/Sources/CompanionCore/LiveActivityRetention.swift` (new) — `shouldRetain(kind:requestId:options:)`, the pure rule that decides what survives backgrounding:  it drops a working bot, an unread `toReview` and a `needsYou` card with no request or no choices, and keeps a pending ask with real choices.
- `ios/App/LiveActivities.swift` — `handle(.endAmbient)` calls the new `endAmbientActivities()`, which ends exactly the activities `LiveActivityRetention` rejects and leaves the rest (and their `lastSent`/`since` bookkeeping) alone; the `AnswerApprovalIntent.handler` assignment moved out of `attach(to:)` into the new `LiveActivityApprovalRoute`; the DEBUG `-live-activity-preview` fixture and its reconciliation guard live here too.
- `ios/App/CompanionApp.swift` — `init()` calls `LiveActivityApprovalRoute.install(session:)` before any view exists.
- `ios/App/Session.swift` — `answerFromLiveActivity(threadId:requestId:choice:isPermission:)` polls for and rebuilds the client under a 20 s bound, then answers quietly; it never re-resolves which request is pending.
- `ios/App/LiveActivities.swift` — `LiveActivityApprovalRoute.dismissCard(threadId:requestId:)` ends the one answered activity.
- `ios/Tests/CompanionCoreTests/LiveActivityLifecycleTests.swift` — background expectations moved from `.endAll` to `.endAmbient`, plus a case asserting background is not sign-out; four new `LiveActivityRetentionTests` cover the retention rule.

## What Was Broken

The Lock Screen card already rendered `Allow` / `Deny` pills through
`Button(intent: AnswerApprovalIntent)`, and that intent already conformed to
`LiveActivityIntent`, which is the protocol that makes a tap run in the **app's**
process.  Two things stopped it being a feature:

1. **The card never survived backgrounding.**  The 2026-09-12 suspension policy
   ends every BotFleet activity on `.background`, so the card left the Lock
   Screen at the moment the phone locked.  That policy is correct for ambient
   work — a local-only stream has nothing to keep a working bot's face honest —
   and wrong for an unanswered ask.
2. **The tap was a silent no-op.**  `AnswerApprovalIntent.handler` was assigned
   in `LiveActivityCoordinator.attach(to:)`, which runs from `RootView.onAppear`.
   The system performs a `LiveActivityIntent` by background-launching the app
   process *without bringing the scene on screen*, so on exactly the launch the
   Lock Screen button depends on, no scene appeared, the handler was `nil`, and
   `perform()` returned `.result()` having done nothing.  Even had the handler
   been installed, `Session.perform` opens with `guard let client`, so a
   cold-launch answer would have failed for want of a rebuilt client.

## Behavior

- **Backgrounding ends ambient work and keeps decisions.**  The lifecycle now asks for `.endAmbient`, and the coordinator ends only what `LiveActivityRetention` rejects (see the two `LiveActivityRetention.swift` / `LiveActivities.swift` bullets above).  Sign-out still ends everything.
- **The answer route exists before any UI.**  `CompanionApp.init` installs it, and `Session.answerFromLiveActivity` rebuilds the client on demand inside a bounded wait, then answers quietly — there is no screen to put an error on.
- **The answer is exact.**  `requestId` and `isPermission` come from the card that drew the buttons, so nothing is re-resolved.  Re-deriving the request from "whatever is pending on this thread" is the bug PR #383's review caught.
- **The card clears itself.**  After the answer lands, `dismissCard` ends the one activity whose thread and `requestId` match.  With the app backgrounded there is no `sync` to redraw the card, so without this the buttons would sit on the Lock Screen claiming an approval that already went through.

## Trade-off

A retained card is stale until the app is next opened, because a local-only
Live Activity has no push path to correct it.  In practice it is corrected
quickly: the first foreground activation runs `awaitFreshState` → `sync`, which
drops the activity as soon as the request is no longer pending.  A card whose
bot went away entirely is ended by the same pass.  The alternative — ending
everything on background — is what made the feature impossible to deliver at
all, so the stale-card window is the cheaper risk.  Push-to-start, tracked on
BF-2410, is what removes the window entirely.

## Validation

- `cd ios && swift test` — 877 tests passed, 0 failures, including four new
  `LiveActivityRetentionTests` and the reworked background cases in
  `LiveActivityLifecycleTests`.
- `xcodegen generate` + unsigned `xcodebuild -scheme BotFleet -sdk
  iphonesimulator` — the app and widget targets compile, which is the only gate
  that covers `LiveActivities.swift`, `CompanionApp.swift` and `Session.swift`;
  `swift test` does not build those targets.
- Physical-device acceptance of tap-approve-from-a-locked-screen is **open**.
  No paired device and no production notification state were mutated.