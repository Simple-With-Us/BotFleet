# 2026-09-08 — iOS App Save And Queued-Message Cancel

## Context & Objective

Owner screenshots: saving Socratic.Trade from the iOS sidebar alerts `unknown room member: 55d4cc07-…`; tapping X on a queued Compiler message alerts `no route: DELETE /api/bots/…/queue/…`.

Do not extra-ship TestFlight.  Ask before bouncing the live Mac harness or running `update-botfleet.sh`.

## Causes

1. **Save.**  `GroupProfileView` always PATCHes `memberIds`.  The Members toggles only list live bots, so a deleted-bot ghost already on the roster is invisible and cannot be unchecked.  The harness then 400s (`unknown channel member` rewritten to `unknown room member`).  `deleteBot` has stripped ghosts since #95; leftover ids remain on disk from before that, or from any path that wrote a roster without going through deleteBot.
2. **Queue X.**  iOS and the harness already speak `DELETE /api/bots/:id/queue/:queueId` (#224).  Packaged `/Applications/BotFleet.app` 1.0.30 companion has no `/queue/` allowlist, so the sidecar answers `no route` before the harness sees the request.  Source `companion/src/routes.ts` on main already allowlists it.

## Changes Made

- `resolveRoomMemberIds` drops ids that were already on the roster but are no longer bots; a newly invented id still 400s.
- Store load persists that cleanup and re-normalizes the lead.
- `GET` `publicGroupState` also strips ghosts so the phone never re-saves them.
- PATCH defaultResponder: a lead that is no longer a member becomes everyone / first member instead of blocking the save.
- iOS save sends only live member ids, keeps original order, and stays on the form when the PATCH fails.
- iOS cancel: 404 `no such queued message` drops the chip; 404 `no route` keeps the chip and asks to update BotFleet on the Mac.
- Desktop member toggle sends the live roster only.

## Verification

```
pnpm typecheck
./node_modules/.bin/vitest run server/store.test.ts
cd ios && swift test
```

Unsigned `xcodebuild` when iOS files change.  No TestFlight upload.  Live BotFleet was not rebuilt.

## Next

Jay: when chats are idle, rebuild the Mac app (`update-botfleet.sh` or equivalent) so the packaged companion picks up the #224 DELETE allowlist.  That is what makes queued X work on the current TestFlight without a new iOS build.  Server ghost-drop needs the always-on harness at `~/apps/botfleet-server` restarted onto this merge.  Ask before either bounce.
