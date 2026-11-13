# 2026-09-03 — Thread lanes, drag-reassign, merge, hourly TestFlight

Seat: GROK.  Branch `grok/thread-lanes`, worktree `~/apps/botfleet-grok-followups`.  Board `8aee326915b34c7c8c27a4cdb93fafca`.

## Thread model

A bot still runs one turn at a time.  Incoming webhooks and resource samples share that bot's **Triggers** task.  Calendar ticks and Run now share **Routines**.  Interactive chat stays on the default task unless the person mints another.  Reassign a thread to another bot to run two of those conversations in parallel.

## Drag and drop

The payload wrote `fromId` and the drop reader required `fromGroupId`, so every drop was a no-op.  Bot rows only accepted files.  Drops now reassign onto a bot or room (darker fill), and dropping a thread onto another thread of the same bot merges the transcripts.

## TestFlight

`ios-testflight.yml` no longer ships from `ios-v*` tags.  Push to `main` (`ios/**`) plus an hourly cron, gated at one successful ship per hour, skip scheduled ticks with no `ios/` change.

## Verify

```bash
pnpm exec vitest run src/lib/thread-drag.test.ts server/routines.test.ts server/tasks.test.ts src/state/store.test.ts
```
