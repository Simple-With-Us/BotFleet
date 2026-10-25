# Releasing

One workflow builds everything: **Actions → Release → Run workflow**.  It
builds macOS (arm64 + x64, signed, notarized, stapled) from a single pinned
commit, verifies every artifact the way a user would
receive it, and preserves one complete artifact set in Actions.  That default
mode does not create or change a GitHub Release.  Tick **draft** to upload the
verified set to a draft on this repository's own
[Releases page](https://github.com/Simple-With-Us/BotFleet/releases).  Tick
**publish** only when that exact run should create or update the draft and make
it public immediately.

There is exactly one publish target: this repository.  `electron-builder.yml`
`publish` names `Simple-With-Us/BotFleet`, which electron-builder bakes into
every packaged app's `app-update.yml`; `release.yml` uploads to the same
repository through its `RELEASES_REPO` variable.  Keep the two in step, or
installed apps check a feed no release ever lands on.  The repository is
public, so no token ever reaches a user's machine.  Upstream kept a separate
`*-releases` repo so its source could stay private; BotFleet never was, and the
owner's rule (2026-09-02) is one repository per app, so the separate
`botfleet-releases` repo is retired.  Nothing under `milind-soni/*` is ours to
publish to.

## The Version of a Release

The workflow refuses to overwrite an already-published version, and the version
it compares is the one stamped from the released commit, not `package.json`'s.

Every release version is `1.0.<commit_count>` of the commit being released,
computed by `scripts/stamp-commit-version.mjs` from a full-history checkout. 
`package.json`'s version is a floor rather than the release number: it only
keeps a build from being numbered below what the tree already claims, and it is
never edited to cut a release.  Because the commit count only grows, two
releases cannot collide and a release cannot go backwards.

So the prerequisite per release is a commit, not a version bump.  Run the
workflow against a ref whose commit count is above the last published release,
and the stamp, the `v<version>` tag, the version inside the app bundle, and the
`version` field of `latest-mac.yml` are all one string, computed once in the
`prepare` job and handed to every later job.

## What Auto-Update Needs on the Release

electron-updater reads a feed file, not the DMG:

- **macOS:** `latest-mac.yml` plus the `BotFleet-<version>-arm64.zip` and
  `BotFleet-<version>-x64.zip` it lists (and their `.blockmap` files).
  The DMGs are for humans; the updater downloads the zips.

A release that carries only DMGs, as
[`v0.1.38`](https://github.com/Simple-With-Us/BotFleet/releases/tag/v0.1.38)
did, cannot be found by any installed app: **Check for updates** fails on every
platform.  Every release cut from `release.yml` carries `latest-mac.yml` and
both macOS zips, and the assemble gate fails the run when any of them is
missing.  Never hand-edit or carry forward a feed file; it pins sha512 hashes of
the exact bytes on the release.

## Why the Gates Exist

Each verification step in `release.yml` maps to a real incident from the
hand-cut releases (0.1.15–0.1.25): stale build output breaking the code
signature, a bare import killing the packaged server on launch while every
check stayed green, helper paths resolving outside the app after bundling,
stapling silently invalidating every published hash, and a finished release
sitting invisible as a draft.  Don't remove a gate without reading the comment
above it.

## One-Time Setup: Signing Credentials

Provide these through the release automation identity's Infisical `prod`
environment or the same-named GitHub Actions secret fallback.  Only the
repository owner handles these values.

### 1. `MAC_CERT_P12_BASE64` + `MAC_CERT_PASSWORD`

The Developer ID Application certificate for team **CC8UTF7ATG**, which is the
identity selector `electron-builder.yml` pins
(`Jay Wedgeworth, LLC (CC8UTF7ATG)`).  The matching certificate's full
Keychain name begins with `Developer ID Application:`.  A certificate
from any other team fails the pinned identity even if it imports cleanly.
Export it from the Mac that currently signs releases:

```sh
# Keychain Access → My Certificates → "Developer ID Application: Jay
# Wedgeworth, LLC (CC8UTF7ATG)" → right-click → Export… → .p12 with a strong
# password, then:
base64 -i DeveloperID.p12 | pbcopy   # → MAC_CERT_P12_BASE64
# the export password             → MAC_CERT_PASSWORD
```

The latest observed run, `33822154040`, stopped at *Import the Developer ID
certificate into a throwaway keychain* with both values empty.  As of September
12, the repository secret-name list still omits this pair; the workflow can also
resolve them from Infisical, whose current values were not inspected here.

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI — revocable, scoped, no 2FA dance):

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
   for team CC8UTF7ATG
2. Generate a **Team Key** with the **Developer** role
3. Download the `.p8` (one chance only), note the Key ID and Issuer ID

```sh
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_P8_BASE64
```

Release creation uses GitHub's short-lived workflow token.  Only the conditional
release job receives `contents: write`; the default artifact-only run keeps
read-only permissions.  No personal access token is needed now that build
artifacts and Releases live in the same repository.

### Local Fallback

The hand-cut path still works when Actions is down or a release needs
surgery: `pnpm package:mac:release`, gate both applications with
`codesign --verify --deep --strict`,
notarize with the local keychain profile (`xcrun notarytool submit …
--keychain-profile AC_PASSWORD`), staple, re-zip, regenerate blockmaps and
`node scripts/regenerate-mac-feed.mjs`, upload to the matching
`Simple-With-Us/BotFleet` release, publish, and always verify the
published bytes against the published feed by downloading them back.

## The Native Mac Build (BF-2486, Phase 6)

The native `BotFleetMac` app has its own pipeline, **Actions → Native Mac Release → Run workflow**, with `scripts/mac-package.sh` as the local equivalent.  Both produce the same asset names from the same pinned commit, and neither ever publishes: tick **draft** to attach the verified assets to the `v<version>` draft, then publish by hand after checking them.

Native assets are `BotFleetMac-<version>.zip`, `BotFleetMac-<version>.dmg` and one `appcast.xml`, on the same GitHub release as the Electron set.  The names are disjoint on purpose: Sparkle reads the appcast, electron-updater reads `latest-mac.yml`, and a native ZIP wearing an Electron name would be offered to installed Electron apps as an update they cannot run.  `scripts/verify-native-release.mjs` fails the run if the two sets ever share a directory.

The version is the same `1.0.<commit_count>` stamp as every other build, computed once in the `prepare` job.  Gates run in the Electron pipeline's order, for the same reasons: the signature verifies before anything is submitted to the notary service, and the ZIP, DMG, feed lengths and appcast are all produced after stapling rewrites the bundle.

Sparkle signing waits on one owner action: create the EdDSA key, back it up in Infisical as `SPARKLE_EDDSA_PRIVATE_KEY_B64`, and put `sign_update` on the packaging path.  Until then the appcast is generated unsigned and the run says so; an app carrying `SUPublicEDKey` refuses unsigned items, so the gap fails closed rather than shipping an unverifiable feed.  The check schedule and probe-retry rules the eventual Sparkle controller must implement already live in `NativeUpdatePolicy.swift` (CompanionCore), with the Electron updater's constants resolved on BF-2486.

Deleting the Node harness is a separate, later step (BF-2515).  `node scripts/audit-node-decommission.mjs` proves every file under `server/`, `companion/`, `shared/` and `electron/` still has an inventory row, and `node scripts/check-decommission-gates.mjs <state.json>` refuses the deletion until the Phase 5 issues are Done and the 24-hour no-Node evidence is asserted.
