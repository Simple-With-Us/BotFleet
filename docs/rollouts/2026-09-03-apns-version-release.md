# 2026-09-03 — APNs wake, desktop 1.0.30, Mac update feed

Seat: GROK.  Branch `grok/apns-version-release`.  Worktree `~/apps/botfleet-grok-apns-release`.  Board `f7d09c8b`.  Issue #183.

## Why

Owner 2026-09-03: make APNs; align desktop numbering with iOS `1.0.x`; cut a full Mac release with `latest-mac.yml` and both zips so Check for updates works.  Defer Windows/Linux first-class.  Keep BotFleet-layer add-ons marked all in testing.

## What changed

- Sidecar APNs payload includes `content-available: 1` so a suspended companion can reconnect without a tap.  HTTP 410 drops the stored token.  Missing p8 logs once; send failures log the status, never the token.
- iOS tap and background fetch parse APNs `botId` / `threadId` (including nested `aps.thread-id`) and open that task.
- Desktop `package.json` and iOS `MARKETING_VERSION` are `1.0.30`.  README, botfleet.app download CTA, and `features.json` point at the 1.0.30 DMG.
- Docs no longer say a killed app cannot wake.  Force-quit still needs a lock-screen tap (iOS rule).

## Parked

- Windows/Linux remain "Not published yet" until the owner is happy with app functioning, then ship with parity.
- Splitting `src/state/store.tsx` (~2.3k), `server/index.ts` (~7.1k), and `electron/main.mjs` (~2.0k) is beneficial later but would mix behavior risk with a versioned release.  Not in this PR.
- Local `patch_*.py` / `fix-*.py` scripts stay on disk and gitignored.  They are leftover one-off rewrite scripts, not product source.  Delete vs archive is a later call.
- GitHub TestFlight still lacks Apple API secrets; this lane does not ship a TestFlight build.

## Extra

`server/kill-tree.test.ts` treated the first stdout chunk as the grandchild pid.  Node 26 prints a `NO_COLOR`/`FORCE_COLOR` warning on stdout when both env vars are set, so that chunk was not a number.  The test now skips non-pid lines.  Product kill behavior is unchanged.

## Verify

```
pnpm typecheck
pnpm exec vitest run companion/src/apns.test.ts companion/test/devices.test.ts server/kill-tree.test.ts
cd ios && swift test --filter DecodingTests
```
