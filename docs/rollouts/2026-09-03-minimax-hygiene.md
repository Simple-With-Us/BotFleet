# 2026-09-03 — MiniMax review hygiene

Seat: GROK.  Branch `grok/minimax-hygiene`.  Worktree `~/apps/botfleet-grok-minimax-hygiene`.  Board `41169a1e`.

## Done without waiting

- Deleted root `compose.yml` (Congress.Trade Deno stack, not BotFleet).
- Gitignored root `patch_*` / `fix-*` / `trace*` mutation scripts so they cannot look like product source.
- Windows CI: Title Case copy tests and the no-owner-defaults tree walk now compare paths with `path.sep`, not a hardcoded `/`.
- Companion warns when `OMB_*_PORT` is set but not a whole number in range.
- README: usage telemetry classifies by working-directory **basename only**.
- `release.yml` assemble fails if `latest-mac.yml` or the two macOS zip artifacts are missing (v0.1.38 shipped DMGs only, so Check for updates cannot work).

## Parked for owner

Windows/Linux first-class vs community, APNs vs documented limit, marketing "all in testing" vs Stable/Beta, splitting store/index/main, archiving vs deleting local patch scripts, version 0.1.38 vs iOS 1.0.x.

## Verify

```
pnpm exec vitest run src/lib/ui-copy.test.ts server/no-owner-defaults.test.ts
```
