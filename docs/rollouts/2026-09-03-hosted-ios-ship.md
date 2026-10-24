# 2026-09-03 — Hosted macos-latest iOS TestFlight ship

> **Superseded 2026-10-18, again 2026-10-24.**  The UTC `YYYYMMDDHHMM` build
> stamp described here is retired.  From 2026-10-18 the fleet took both numbers
> from the repo's commit count;  since 2026-10-24 (AFC-517) the two numbers are
> independent:  the marketing version is the next patch on the App Store
> Connect train (`1.0.<P+1>`), and the build number is the repo's commit count
> raised above the App Store Connect floor.  This file stays as the record of
> what was done on 2026-09-03.

## Summary

BotFleet TestFlight now follows the Congress.Trade / DealDex / Socratic.Trade hosted path:  GitHub-hosted `macos-latest`, push path filter on `ios/**`, optional schedule and dispatch, vendored `scripts/ios-fleet`, `force_ship` left at the script default.

The retired `.github/workflows/ios-testflight.yml` (dispatch / `ios-v*` tags, then a later inline `xcodebuild`) is removed so a merge cannot double-upload.

## Why

Forty-five consecutive TestFlight workflow runs failed.  The last ones died on empty `APPLE_API_*` Actions secrets.  Plumber has now set those names on the repo.  The conductor decision is hosted `macos-latest` with a path filter, not Mac-local `scripts/ios-ship-testflight.sh` as the primary path.

## What landed

- `.github/workflows/ios-ship.yml` — push on `ios/**` plus the ship scripts, `workflow_dispatch`, cron `18,48` (offset from ST/CT/DD/UM).  Runner `macos-latest`.  Checkout `fetch-depth: 0`.  Cache `~/.cache/ios-fleet`.  Scheduled gate skips when there is no last-ship file.  No extra flags on the wrapper.
- `scripts/ios-fleet/` — vendored ship script, ASC helper, ExportOptions, BotFleet-only `apps.json` (`app.botfleet`, team `CC8UTF7ATG`, marketing `1.0.N`, build UTC `YYYYMMDDHHMM`).
- `scripts/ios-appstore-gm-prepare.sh` — maps existing secrets `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8_BASE64`, `IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`.  Decodes the p8.  Imports Apple Distribution.  Never prints values.  Does not mint a key.  Does not install a new provisioning profile (automatic signing).
- `scripts/ios-ship-testflight.sh` — prefers the in-repo fleet copy, then `/Users/jay/apps/ios-fleet`.
- Contract tests in `scripts/ios-ship-workflow.node-test.mjs` plus the scheduled-gate offline suite.

## Secrets

Existing repo Actions names only.  No new secret names.  No new profiles.  `IOS_PROVISIONING_PROFILE_BASE64` remains on the repo but is unused by the fleet automatic-signing export.

## Verification

- `node --test scripts/ios-ship-workflow.node-test.mjs`
- `bash scripts/ios-fleet/test-scheduled-ship-gate.sh`
- `pnpm typecheck` (unchanged product code)

A TestFlight upload is not run from this lane.  The first hosted ship is a merge to `main` that passes the `ios-ship.yml` path filter, with `force_ship` at default.

## Follow-ups

- First green hosted IPA is what updates the home-screen icon from #165.
- Desktop Release still needs `MAC_CERT_*` and `RELEASES_PAT` (board `5a2b2e02`); that is not this lane.
