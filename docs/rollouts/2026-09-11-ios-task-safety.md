# iOS Task Safety

## Problem

The iOS companion sent messages and Stop actions without the displayed task id, and it did not reuse the pending message UUID as an idempotency key.  A lost response could therefore run an instruction twice or let an action race a desktop task switch.

Background APNs delivery also navigated to the notification task and reported completion before refresh finished.  A snapshot refresh could later overwrite a newer SSE frame whose cursor had already advanced.

## Behavior

- Bot and room sends carry the displayed `threadId` and pending UUID.  The client retries one transport failure with the same request and refreshes state after a task-conflict 409.
- Bot Stop carries the displayed `threadId`.  Room Stop remains tracked in #310.
- Bot and room message routes replay only a fulfilled outcome for the same entity, expected task, and key after a task switch.  Unknown, in-flight, rejected, or expired keys return 409 without dispatching into the new task.
- Background delivery performs a cancellation-bounded refresh and never navigates.  Notification taps retain navigation behavior.
- The refresh callback is installed during app initialization for cold background launch.  Every asynchronous fleet snapshot checks both the pairing generation and a state-identity hydration token, so conflict recovery, notification lookup, and background or cold-stream hydration cannot apply data from an old Mac or overwrite a newer reducer frame.

## Validation

- `cd ios && swift test`
- `pnpm typecheck`
- `pnpm vitest run server/idempotency.test.ts server/index.test.ts -t 'IdempotencyCache|replays committed sends after a task switch'`
- Hosted `Swift tests + iOS build` is the application compile gate because the local Xcode installation has no eligible iOS runtime.

No user-visible layout or copy changed, so this rollout does not require a simulator screenshot.
