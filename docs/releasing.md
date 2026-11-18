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

The workflow refuses to overwrite an already-published release, and the version it compares is the app version planned from the released commit, not `package.json`'s.

One release carries three values (BF-2588).  The `prepare` job plans them once with `scripts/electron-release-version.mjs` from a full-history checkout and hands them to every later job:

| Value | Shape | Where It Lands |
|---|---|---|
| Marketing version | `0.1.0` | `CFBundleShortVersionString`, the version a person sees |
| Build number | `YYYYMMDDHHMM` | `CFBundleVersion` |
| App version | `1.0.<build>` | The `package.json` inside the app, the `v<app version>` tag, the artifact names and the `version` field of `latest-mac.yml` |

The build number is the released commit's Central Time merge-to-main stamp, its committer date written as twelve digits.  It comes, through `scripts/mac-release-version.mjs`, from the shared planner that the iOS ship and the native Mac release also ask, which reads the App Store Connect build inventory: a commit's first build is its own stamp, and when that inventory already holds a macOS build with that stamp, or any build above it, the plan is the highest existing build plus one.  The planner fails the run rather than guessing when it cannot read a complete inventory.  The stamp is the committer date of whichever commit the run is given, which is a merge-to-main time only for a commit on `main`.

The app version exists because electron-updater orders releases by semver on the app version and by nothing else.  `latest-mac.yml` has no build field, so two releases that both said `0.1.0` would compare equal and no installed app would be offered an update.  The build therefore travels in the patch of the app version, the slot the retired `1.0.<commit_count>` scheme used.  The prefix stays `1.0` on purpose.  BF-2458 recorded an installed app on `1.0.31` and a last published feed that says `0.1.38`.  A `0.1.<build>` feed would read as a downgrade to an install on the `1.0` line and be refused, while `1.0.<build>` sorts above both of those versions and above every `1.0.<commit_count>` that came before it, because a merge stamp is twelve digits.  Those two versions are the evidence the scheme was designed against, not a fresh measurement of what is installed or published today.  The updater sets no `allowDowngrade`, and none should be added.

So the prerequisite per release is a commit, not a version bump and not a commit count.  `package.json`'s own version is never edited to cut a release; the workflow hands the app version to electron-builder as `extraMetadata`, because the provenance gate refuses a dirty checkout.  An Electron release is not part of the inventory the planner reads, so running the workflow again on the same commit plans the same app version unless that inventory has moved, and the overwrite guard stops a draft or publish run once `v<app version>` is published.

`prepare` also needs the App Store Connect key, because the shared planner reads that inventory.  It loads `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` and `APPLE_API_KEY_P8_BASE64` through the `INFISICAL_IOS_SHIP_READ_TOKEN` binding.  All three are required and that step passes no GitHub secret fallback, so a run cannot plan a version without them.

## What Auto-Update Needs on the Release

electron-updater reads a feed file, not the DMG:

- **macOS:** `latest-mac.yml` plus the `BotFleet-<version>-arm64.zip` and
  `BotFleet-<version>-x64.zip` it lists (and their `.blockmap` files).
  The DMGs are for humans; the updater downloads the zips.
  Here `<version>` is the app version, `1.0.<build>`, not the marketing version.

A release whose feed lists only DMGs, as the feed on
[`v0.1.38`](https://github.com/Simple-With-Us/BotFleet/releases/tag/v0.1.38)
does, cannot update any installed app: the macOS updater downloads a ZIP and
that feed names none, so **Check for updates** cannot install from it.  Every
release cut from `release.yml` carries `latest-mac.yml` and both macOS zips,
and the assemble gate fails the run when any of them is
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

Provide these in the Infisical `prod` environment, root folder, of the project the `INFISICAL_PROJECT_ID` secret names.  The workflow reads them there with the dedicated read-only release service token, `INFISICAL_RELEASE_READ_TOKEN`, and accepts the same-named GitHub Actions secrets as a fallback.  For these values that fallback is wired only into the `mac` job's certificate and notarization steps.  The three `APPLE_API_*` names in subsection 2 must also be present in Infisical itself, readable by the `INFISICAL_IOS_SHIP_READ_TOKEN` binding, because `prepare` reads them through that token with no GitHub fallback before any build starts (see The Version of a Release); a run that has them only as GitHub Actions secrets fails there.  No machine identity is used, and none is a fallback.  The source bindings, and what an audit of them found, are recorded in [the service token bindings rollout](rollouts/2026-11-03-service-token-bindings.md).  Only the repository owner handles these values.

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

The later binding audit recorded in [the service token bindings rollout](rollouts/2026-11-03-service-token-bindings.md) found the required literal values present in the release reader's scope.  That is the audit's observation at the time, not a statement about today's values.

### 2. `APPLE_API_KEY_P8_BASE64` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER_ID`

An App Store Connect API key for notarization (better than an app-specific
password for CI — revocable, scoped, no 2FA dance).  The `prepare` job reads
the same three names to plan the version, so they have to be in Infisical, not
only in GitHub Actions secrets:

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
   for team CC8UTF7ATG
2. Generate a **Team Key** with the **Developer** role
3. Download the `.p8` (one chance only), note the Key ID and Issuer ID

```sh
base64 -i AuthKey_XXXXXXXX.p8 | pbcopy   # → APPLE_API_KEY_P8_BASE64
```

Release creation uses GitHub's short-lived workflow token.  `release.yml` grants
`contents: write` at workflow level, so the token of every job carries that
scope on every run, the default artifact-only run included; it is not a
read-only run.  Only the conditional release job creates, changes or publishes
a release with it, and every checkout sets `persist-credentials: false`.  No
personal access token is needed now that build artifacts and Releases live in
the same repository.

### Local Fallback

The hand-cut path still works when Actions is down or a release needs
surgery: `pnpm package:mac:release`, gate both applications with
`codesign --verify --deep --strict`,
notarize with the local keychain profile (`xcrun notarytool submit …
--keychain-profile AC_PASSWORD`), staple, re-zip, regenerate blockmaps and
`node scripts/regenerate-mac-feed.mjs`, upload to the matching
`Simple-With-Us/BotFleet` release, publish, and always verify the
published bytes against the published feed by downloading them back.

A hand-cut build has to be given the version the workflow would have planned, or electron-builder leaves the app, the artifact names and the feed on `package.json`'s version.  Plan the three values with `node scripts/electron-release-version.mjs --repo-root . --sha <commit>`, which reads the App Store Connect inventory unless it is given an exact `--build`.  Export `BOTFLEET_BUILD_VERSION` (the app version) and `BOTFLEET_MARKETING_VERSION` as the workflow does, then pass the workflow's three overrides to each per-architecture script, `package:mac:arm64:release` and `package:mac:x64:release`: `-c.extraMetadata.version=<app version>`, `-c.mac.bundleShortVersion=<marketing version>` and `-c.mac.bundleVersion=<build>`.  Arguments appended to the combined `package:mac:release` script reach only its last command.  Give `scripts/regenerate-mac-feed.mjs` the app version as its second argument, after the feed path, and run `node scripts/verify-packaged-versions.mjs <app> --version <app version> --build <build>` on each application before notarizing, as the workflow's gate does.

## The Native Mac Build (BF-2486, Phase 6)

The native `BotFleetMac` app has its own pipeline, **Actions → Native Mac Release → Run workflow**, with `scripts/mac-package.sh` as the local equivalent.  Both cut the same asset set from the same pinned commit, and neither ever publishes: tick **draft** to attach the verified assets to the `v<version>-<build>-native` draft, then publish by hand after checking them.  The version baked into the names differs by path: the workflow plans `0.1.0` with the commit's merge-stamp build from the shared planner, while the local script stamps `1.0.<commit_count>` offline (BF-2588).

Native assets are `BotFleetMac-<version>.zip`, `BotFleetMac-<version>.dmg` and one `appcast.xml`, on their own `v<version>-<build>-native` release rather than on the Electron pipeline's `v<version>` one.  They cannot share that release: `release.yml` verifies that its release holds exactly the Electron asset set and deletes every asset it does not recognise, so a shared tag would either fail the Electron release or delete the native ZIP, DMG and appcast.  The names are disjoint on purpose as well: Sparkle reads the appcast, electron-updater reads `latest-mac.yml`, and a native ZIP wearing an Electron name would be offered to installed Electron apps as an update they cannot run.  `scripts/verify-native-release.mjs` fails the run if the two sets ever share a directory.

The version is the shared marketing version `0.1.0` with the commit's Central merge-stamp build, planned once in the `prepare` job from the same planner the iOS ship asks (BF-2588).  Gates run in the Electron pipeline's order, for the same reasons: the signature verifies before anything is submitted to the notary service, and the ZIP, DMG, feed lengths and appcast are all produced after stapling rewrites the bundle.

Sparkle signing is required for a trusted run (BF-2628).  Before archiving, the workflow runs the canonical resolver, `scripts/native-update-release-config.mjs`, which uses `INFISICAL_NATIVE_RELEASE_READ_TOKEN` to read `BOTFLEET_NATIVE_UPDATE_FEED_URL` and `BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY` from the Infisical `prod` root folder; the archive carries them as `SUFeedURL` and `SUPublicEDKey`.  The same-named GitHub variables are optional mirrors, compared and never trusted: each one that is set must match its canonical value byte for byte, and a missing, malformed or mismatched value fails the run.  After stapling, the run loads `SPARKLE_EDDSA_PRIVATE_KEY_B64` through the same token and signs the final ZIP.  The workflow installs Sparkle's `sign_update` itself, because that tool is not part of the runner image, and a key with no tool is a hard error rather than a quiet unsigned feed.  A run with no key fails: the key is a required secret, and the appcast step refuses to continue without it.  The `unsigned-draft` input is the only way past a missing key.  That run still resolves the canonical feed URL and public key and embeds them, and the workflow skips its draft job, so the workflow itself attaches nothing the run builds.  The only marking is in the run's log, which calls the output an unverified draft that is not activatable.  The files carry no such marking: the run uploads the same `native-mac-release` and `botfleet-native-<version>-<sha>` Actions artifacts, with the same file names, as a trusted run, signed with the Developer ID, notarized and stapled.  When the key was missing, the one difference inside them is an appcast item with no `sparkle:edSignature`.  Never attach them to a release by hand.

Verification is cryptographic rather than a presence check.  `scripts/verify-native-release.mjs`, run with `--require-signature --public-key`, checks the appcast's Ed25519 signature against the canonical public key over the final ZIP bytes, once in the build job and again in the assemble job, which resolves the public key from Infisical a second time.  The local script holds distributable packaging to the same rule: it runs the same resolver, so it needs `INFISICAL_NATIVE_RELEASE_READ_TOKEN` in its environment, and it exits before archiving unless `SPARKLE_EDDSA_KEY` names the key file and `sign_update` is on the `PATH`.  Only `--skip-notarize` may omit them.  That build goes to an `UNSIGNED/` directory with no appcast and is not distributable, and a public field supplied to that path is still checked against its canonical value.

The updater itself exists in source.  `ios/MacUpdater/NativeMacUpdater.swift` and `NativeUpdatesCommands.swift` adapt Sparkle to `NativeUpdateService.swift` (CompanionCore), which applies the check schedule from `NativeUpdatePolicy.swift`, where the probe-retry rules also live, with the Electron updater's constants resolved on BF-2486.  `ios/project.yml` links the `MacUpdater` sources and the Sparkle package into the `BotFleetMac` target and generates `SUFeedURL` and `SUPublicEDKey` from the two build settings, which default to empty.  That is source readiness only.  As of November 17, 2026, nothing under `ios/MacApp` references the updater.  Composing it into the Mac app, activating a verified public feed and key, cutting a signed and notarized release, and proving an installed previous-build update are separate completion boundaries, recorded in [the native update consumer rollout](rollouts/2026-11-03-native-update-consumer.md).  This section states what the workflow and the script require, not whether the key or the public values are provisioned.

Deleting the Node harness is a separate, later step (BF-2515).  `node scripts/audit-node-decommission.mjs` proves every file under `server/`, `companion/`, `shared/` and `electron/` still has an inventory row, and `node scripts/check-decommission-gates.mjs <state.json> --bundle <bundle.json> --source-sha <sha> --build <build> --artifact-sha256 <sha256>` refuses the deletion until the Phase 5 issues are Done, the 24-hour no-Node evidence is asserted, and the private final evidence bundle binds every receipt to the candidate.  That gate covers the Mac-local harness only: the optional `deploy/linux-server/` server deployment is deliberately retained (BF-2544), is audited as a retained path rather than as a gap, and is never a decommission target.
