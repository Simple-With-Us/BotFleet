# Releasing

One workflow builds everything: **Actions → Release → Run workflow**.  It
builds macOS (arm64 + x64, signed, notarized, stapled), Windows, and Ubuntu
from a single pinned commit, verifies every artifact the way a user would
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

The workflow refuses to overwrite an already-published version, so the only
prerequisite per release is that `package.json`'s version is bumped on the
ref you run it against.

## What Auto-Update Needs on the Release

electron-updater reads a feed file, not the DMG:

- **macOS:** `latest-mac.yml` plus the `BotFleet-<version>-arm64.zip` and
  `BotFleet-<version>-x64.zip` it lists (and their `.blockmap` files).
  The DMGs are for humans; the updater downloads the zips.
- **Windows:** `latest.yml` plus `BotFleet-<version>-setup.exe` and its
  `.blockmap`.
- **Ubuntu:** `latest-linux.yml` plus the AppImage.

A release that carries only DMGs, as
[`v0.1.38`](https://github.com/Simple-With-Us/BotFleet/releases/tag/v0.1.38)
did, cannot be found by any installed app: **Check for updates** fails
on every platform.  `1.0.31` is the first desktop version prepared to ship
with `latest-mac.yml` and both macOS zips from `release.yml`.  Never
hand-edit or carry forward a feed file; it pins sha512 hashes of the exact
bytes on the release.

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
