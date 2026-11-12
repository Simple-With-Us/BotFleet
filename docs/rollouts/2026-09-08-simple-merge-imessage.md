# Simple-mode merge-all and iMessage trigger cards

**Date:** Mon, Sep 8, 2026  
**Seat:** BF-FIXER  
**Board:** `8bfc6b0b`  
**Branch:** `fixer/simple-merge-imessage`  
**Worktree:** `~/apps/botfleet-fixer-simple-imessage`

## Why

Switching the workspace to Simple used to hide extra threads without offering to fold them.  iMessage inbound painted as a blue user bubble, and the Mac relay forwarded every bot text on a mapped thread.

## What landed

- Settings → Workspace Layout: choosing Simple from Projects asks **Merge All Threads** or **Keep Extra Threads Hidden**.  `PATCH /api/conversation-mode` accepts `mergeThreads: true` and folds extra bot and room conversations into the active thread.
- iMessage inbound is wrapped as `[from iMessage]` inside an `IMESSAGE INBOUND` block.  Mac and iOS render it as the same left-edge work card as a webhook trigger.
- Bot replies meant for iMessage must start with `[to iMessage]`.  Only those leave BotFleet.  The tag is stripped before Messages.app.  In-app replies stay in-app.
- `~/apps/botfleet-imessage-relay.py` POSTs `{text, source:"imessage"}` and gates outbound on the tag.  LaunchAgent `com.jay.botfleet-imessage-relay` stays Retired/Forbidden under jay.

No TestFlight.  No DMG.  Live harness still needs `update-botfleet.sh` after merge.

## Verify

```bash
cd ~/apps/botfleet-fixer-simple-imessage
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec tsc -b
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec tsc -p tsconfig.server.json
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec vitest run shared/imessage-message.test.ts server/tasks.test.ts server/group-tasks.test.ts
PATH=/opt/homebrew/opt/node@24/bin:$PATH pnpm exec vitest run server/index.test.ts -t "merges extra threads when switching to Simple"
cd ios && swift test --filter ImessageMessageTests
python3 -m py_compile ~/apps/botfleet-imessage-relay.py
```

All of the above passed on this lane before the PR.

## Follow-ups

- Reload the iMessage relay only from the `agents` account, never under `jay`.
- Mac app needs `update-botfleet.sh` for the harness wrap and persona rule to go live.
