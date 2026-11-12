# 2026-09-05 — iOS keeps busy-bot sends instead of discarding the 202 queueId

## Context & Objective

Board P0 `b614a1c6`: a message sent to a busy bot vanished on iOS.  The harness steer-queue holds that line out of `messages[]` until drain, and returns `202 { queued: true, queueId, threadId }`.  Web records `pendingQueued` and paints a chip.  iOS treated 202 as success and threw the body away.

Do not extra-ship TestFlight.  Ask before spend.

## Changes Made

- `CompanionClient.send(text:toBot:)` decodes `SendMessageResult` instead of discarding the body.
- `CompanionState` holds `pendingQueued` keyed by thread, the same identity as web.  `visibleTranscript` appends those rows so ChatView does not have to invent a second fold.
- A drain `message` frame with `queueId` retires the chip.  A drain that beats the POST continuation is remembered so the chip does not resurrect.
- Companion sidecar allowlists `DELETE /api/bots/:id/queue/:queueId` so cancel matches the desktop chip.
- Queued footer copy: "Queued — sends when this turn finishes", busy-gated like web.

Touched files:

- `ios/Sources/CompanionCore/Models.swift`
- `ios/Sources/CompanionCore/Client.swift`
- `ios/Sources/CompanionCore/Store.swift`
- `ios/App/Session.swift`
- `ios/App/ChatView.swift`
- `ios/Tests/CompanionCoreTests/StoreTests.swift`
- `ios/Tests/CompanionCoreTests/DecodingTests.swift`
- `companion/src/routes.ts`
- `companion/test/routes.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-05-ios-busy-queue.md`

## Decisions & Trade-offs

Did not append into `messages[]` from the phone — that would fight the server's leaf/queue invariant.  Did not upload TestFlight.  Did not bounce Coolify for the unrelated CT 502 flap (health was 200 when this lane started).

## Verification State

```
cd ios && swift test
# 221 tests, 0 failures
./node_modules/.bin/vitest run companion/test/routes.test.ts
# 62 passed
```

Unsigned `xcodebuild -scheme BotFleet -destination 'generic/platform=iOS'` was started locally and sat resolving sentry-cocoa; CI `ios` job is the merge gate for the app target.  No TestFlight upload from this seat.

CI `typecheck + test` on PR #224 failed on all three OS jobs in `server/antigravity-quota.test.ts`: fixture `resetTime` `2026-09-05T03:58:25Z` had passed, so `QuotaCooldownRegistry.get` dropped Gemini cooldowns.  Fixture resets are now `Date.now() + 5d`.  That file is unrelated to the iOS chip; it was blocking the P0 merge.

## Next Steps & Blockers

Hosted ios-ship may pick up `ios/**` on merge.  That is the existing schedule, not an extra-ship from this seat.

## Zero-Code Findings

Claude worktree `~/apps/botfleet-claude-iosmsg` on `claude/ios-message-vanish` had no unique commits.  CT `/api/health` at start: HTTP 200, `ok: true`.
