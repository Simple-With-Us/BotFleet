# 2026-09-22 — Bundle Identifier Migration


## 2026-10-07 — iOS Ship IDs On `app.botfleet.ios` (ASC Live)

Owner confirmed the App Store Connect app for **`app.botfleet.ios`** (appleId **`6820175685`**).  Hosted ios-ship, `scripts/ios-fleet/apps.json`, `ios/project.yml`, and `TestFlightUpdateCheck.swift` now target that record.  `ship-testflight.sh` refuses legacy **`app.botfleet`** / `6806379515`.  Widget extension bundle is **`app.botfleet.ios.widgets`**; register that App ID in ASC before shipping widgets.  Universal Links AASA on `botfleet.app` still lists the legacy app ID until the owner updates hosting (out of scope for repo-only ship-ID flips).

## 2026-10-01 — iOS Ship IDs Stayed On `app.botfleet` Until ASC App ID Exists (superseded 2026-10-07)

Schedule run [36839653889](https://github.com/Simple-With-Us/BotFleet/actions/runs/36839653889) failed the asc-seq gate (`rc=2`) because `scripts/ios-fleet/apps.json` briefly pointed at `app.botfleet.ios`, which had **no** App Store Connect app record at that time.  Live ASC iOS app was `app.botfleet` / appleId `6806379515`.

Until `app.botfleet.ios` existed in App Store Connect, hosted ios-ship kept `bundleId: app.botfleet` in `scripts/ios-fleet/apps.json`, matched `ios/project.yml` / `TestFlightUpdateCheck.swift`, and used appleId `6806379515` so `latest-build-seq` and `ensure-tf-ready` could verify against the live app.  `asc-api.mjs` exact-matches `filter[bundleId]` results and can fall back to `appleId` when provided.

Issue raised on the macOS signing-cert change window, where the owner approved a fleet-wide bundle rename to `app.<name>.<platform>` plus a fresh app group (`app.<name>`) and associated domain (`<name>.app`).  This document covers **BotFleet only**; the rest of the fleet (Autorotate, ContactLogo, DealDex, HogHunter, Socratic.Trade, Congress.Trade, Usage-Monitor, the MiniMax-ios companion) is on separate lanes owned by other seats.  The fleet-wide context lives in `/Users/jay/.minimax/sessions/mvs_0bdfe8c73c1046a986df888aa99dcb2e/workspace/fleet-bundle-id-plan.md`.

## Previous → New

| Surface | Previous | New (target when registered) |
|---|---|---|
| macOS app (Electron main) | `com.botfleet.app` | `app.botfleet.macos` |
| macOS Recorder helper | `com.botfleet.app.recorder` | `app.botfleet.recorder.macos` |
| macOS Speech helper | `com.botfleet.app.speech-helper` | `app.botfleet.speech.macos` |
| Always-on LaunchAgent (harness) | `com.jay.botfleet-server` | `app.botfleet.server` |
| iOS app | `app.botfleet` | `app.botfleet.ios` (ASC still `app.botfleet` today) |
| iOS widgets | `app.botfleet.widgets` | `app.botfleet.ios.widgets` (ASC still `app.botfleet.widgets` today) |
| App group (new) | — | `group.app.botfleet` |
| Associated domain (new) | — | `botfleet.app` |

The macOS app does not ship an `.entitlements` file under `electron/` today; entitlements land when `electron-builder` signs against a developer profile.  When that file is introduced it must add `com.apple.security.application-groups: [group.app.botfleet]` and `com.apple.developer.associated-domains: [applinks:botfleet.app, webcredentials:botfleet.app]` to match the iOS side and the new app-group/associated-domain convention.  The matching `botfleet.app/.well-known/apple-app-site-association` (AASA) is out of scope for this PR — the owner handles DNS + Apple Developer Portal App ID registration separately.

## What Changed In The Repo

- `electron-builder.yml` `appId`, `electron/main.mjs` `setAppUserModelId`, `electron/cua.mjs`, `electron/cua-linux-runtime.cjs` → `app.botfleet.macos`.
- `electron/resources/recorder-helper-Info.plist` → `app.botfleet.recorder.macos`.
- `electron/resources/speech-helper-Info.plist` → `app.botfleet.speech.macos`.
- `ios/project.yml` `PRODUCT_BUNDLE_IDENTIFIER` for `BotFleet` and `BotFleetWidgets` → **`app.botfleet` and `app.botfleet.widgets`** (live ASC + hosted ios-ship; not `app.botfleet.ios` until that App ID exists).  `bundleIdPrefix: app.botfleet` and the `group.app.botfleet` app-group reference stay.  Re-run `xcodegen generate` (the .pbxproj is gitignored) to materialise the change.
- `ios/Sources/CompanionCore/TestFlightUpdateCheck.swift` `bundleId` and the `TestFlightUpdateCheckTests.swift` manifest fixture → **`app.botfleet`** (same ASC key as hosted ship).
- `scripts/update-botfleet-mac.mjs` (`EXPECTED_BUNDLE_ID`, default LaunchAgent plist path, default `BOTFLEET_LAUNCH_AGENT_LABEL`), `scripts/smoke-cua.mjs`, `scripts/update-botfleet-mac.node-test.mjs`, `scripts/smoke-linux-package.mjs`, `electron/cua-linux-runtime.test.mjs` (3 fixtures), `server/local-computer.ts` and `local-computer.test.ts` → `app.botfleet.macos`.
- `scripts/ios-fleet/apps.json` (vendored BotFleet copy) and `scripts/ios-ship-workflow.node-test.mjs` → **`app.botfleet`**, **`app.botfleet.widgets`**, appleId `6806379515` (ios-ship registry must match ASC, not the future `.ios` target).
- `scripts/ios-fleet/test-publish-ios-versions.sh` baseline manifest key + all `run_pub` / `read_field` references → **`app.botfleet`**.
- `scripts/ios-ship-testflight.sh` and `scripts/ios-fleet/README.md` comments updated to reference **`app.botfleet`** for hosted ships.
- `server/test-parent-watchdog.ts` and `server/index.ts` source comments referencing the LaunchAgent → `app.botfleet.server`.
- `electron/server-boot-probe.mjs` comment → `app.botfleet.server`.
- `LICENSE`/`docs/EFFORT-LOG.md` archaeology rows, `docs/audits/2026-09-01-botfleet-analysis-v2.md`, `docs/audits/2026-09-02-delta-audit-reconciliation.md`, `docs/rollouts/2026-09-01-resource-triggers.md` keep historical `com.botfleet.app` / `com.jay.botfleet-server` mentions verbatim as archaeology, each with a one-line dated note at the top explaining the rename.
- `AGENTS.md` `Mac Local Processes` sentence updated to `app.botfleet.server`; a new `Bundle Identifiers` section documents the canonical table for future seats; a dated top-of-file callout points to this rollout doc.
- `docs/observability.md` step 1 → `app.botfleet.server`.
- `docs/EFFORT-LOG.md` gains a new dated stanza at the top describing this rollout.

## Cross-Repo Files Touched (Not In This PR's Diff)

The same LaunchAgent rename is replicated outside the repo so the live harness matches the source-of-truth next time it restarts:

- `~/Library/LaunchAgents/com.jay.botfleet-server.plist` — `Label` → `app.botfleet.server`.  File name will move to `~/Library/LaunchAgents/app.botfleet.server.plist` on the owner's reload.
- `/Users/jay/apps/botfleet-server-start.sh` — `PREFIX` and `~/Library/Logs/botfleet/server.log` references updated to the new label.
- `/Users/jay/apps/botfleet-imessage-relay.py` — searched for any reference to the LaunchAgent label or bundle ID; none were found (it talks to `http://127.0.0.1:8799`, not to launchd), so the file is untouched.
- `/Users/jay/apps/botfleet-server` (worktree) — left untouched.  It is a worktree of the canonical BotFleet source (private operations record); once the PR merges to `main` and the detached harness re-fetches, the source tree there will carry the new strings.

## Owner Action Items

1. `apple developer portal` — register new explicit App IDs: `app.botfleet.macos`, `app.botfleet.recorder.macos`, `app.botfleet.speech.macos`, **`app.botfleet.ios`**, **`app.botfleet.ios.widgets`**, and the app-group `group.app.botfleet`.  iOS hosted ships stay on **`app.botfleet`** until those ASC records exist and the repo is intentionally moved to the `.ios` IDs.  This PR does not have the credentials to do so.
2. `botfleet.app` DNS — create the AASA at `https://botfleet.app/.well-known/apple-app-site-association` (Universal Links + web credentials for the **live** iOS bundle IDs and the future `app.botfleet.ios` targets) and host it on the verified `botfleet.app` zone.  The associated-domains entitlement values `applinks:botfleet.app` and `webcredentials:botfleet.app` are already wired in `ios/project.yml`; they will validate once the AASA is reachable.
3. Code-signing — the certificate refresh is vendor-driven and out of scope.  After the cert swap, `scripts/update-botfleet-mac.mjs` will repackage the `.app` with the new bundle ID without any further source change (it reads `EXPECTED_BUNDLE_ID = "app.botfleet.macos"` from this PR).
4. TestFlight re-upload — vendor (hosted `ios-ship.yml`).  No extra source change beyond keeping **`ios/project.yml`**, **`apps.json`**, and ASC on the same bundle (`app.botfleet` today).
5. macOS entitlements — when the macOS app gains an `.entitlements` file under `electron/`, add:
   ```xml
   <key>com.apple.security.application-groups</key>
   <array>
     <string>group.app.botfleet</string>
   </array>
   <key>com.apple.developer.associated-domains</key>
   <array>
     <string>applinks:botfleet.app</string>
     <string>webcredentials:botfleet.app</string>
   </array>
   ```
   The iOS side already has both, so the iOS entitlement copy (`ios/App/BotFleet.entitlements`) is unchanged.
6. LaunchAgent reload — `launchctl bootout gui/501/com.jay.botfleet-server && launchctl bootstrap gui/501 ~/Library/LaunchAgents/app.botfleet.server.plist` (or `unload` then `load -w`).  This is destructive against the live harness and is intentionally **not** done in this PR; the owner reloads after the App IDs are registered and the cert is in place.

## Verification

- `git grep -nE 'com\.botfleet\.app|com\.jay\.botfleet-server'` returns only archaeology hits in `docs/audits/*` (with dated notes), `docs/rollouts/2026-09-01-resource-triggers.md` (with a dated note), and prior `docs/EFFORT-LOG.md` rows (historical record).
- `plutil -lint electron/resources/recorder-helper-Info.plist` and `plutil -lint electron/resources/speech-helper-Info.plist` clean (re-ran locally).
- `xcodegen generate` regenerates `ios/BotFleet.xcodeproj` from `ios/project.yml`; bundle IDs flow into the target build settings without any hand edit.
- iOS unit tests in `ios/Tests/CompanionCoreTests/TestFlightUpdateCheckTests.swift` use **`app.botfleet`**; the manifest fixture matches what `publish-ios-versions.sh` writes under that key for hosted ships.
- CUA tests (`electron/cua-linux-runtime.test.mjs`, `server/local-computer.test.ts`) updated; the env `CUA_DRIVER_HOST_BUNDLE_ID` now carries `app.botfleet.macos` so the embedded driver host check matches the Electron main's `setAppUserModelId`.
- `scripts/update-botfleet-mac.mjs` defaults moved to `app.botfleet.server` for both the LaunchAgent plist path and the `BOTFLEET_LAUNCH_AGENT_LABEL` env, so an un-overridden invocation picks up the new label.
- `botfleet-imessage-relay.py` was searched for `com.botfleet.app`, `com.jay.botfleet-server`, `app.botfleet.widgets`; no matches, no edits required.

## Credential And Pairing Handoff

- **macOS safeStorage.** Changing `appId` changes the designated requirement, so the renamed executable cannot decrypt `credentials.bin`.  Before the updater swaps bundles, the still-authorized `com.botfleet.app` binary is launched with `--export-safe-storage-migration` and writes `credentials.migration.json` (mode 0600) next to `credentials.bin`.  The renamed app imports that file on first read, re-encrypts with its own `safeStorage` key, and deletes the handoff file.
- **iOS pairing.** `CompanionConnectionStore.exportLegacyPairingToSharedStorage()` copies `UserDefaults.standard` into `group.app.botfleet` at launch without overwriting a suite that already has data.  A future rename to `app.botfleet.ios` reads the suite first, then standard.  Keychain writes use `CC8UTF7ATG.group.app.botfleet` with a private-group fallback on read.
- **URL scheme.** Pairing QR codes use `botfleet-ios://pair`.  The iOS app also still registers legacy `botfleet://` so older links and Live Activities can land here.

## Out Of Scope

- Apple Developer Portal App ID registration (owner).
- `botfleet.app` AASA hosting + DNS (owner).
- Code-signing cert refresh (vendor).
- TestFlight re-upload (vendor).
- Renaming `~/Library/Logs/botfleet/server.log` (file path stays; log readers may parse the literal name).
- Other fleet apps' bundle renames (separate per-app PRs, separate seats).
