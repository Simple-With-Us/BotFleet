# Native Host Package Smoke

The optional native headless host ships as its own artifact, beside the Mac
app and not inside it.  This recipe packages the checkout with the product's
own packager and then runs the packaged executable, so the identity the
artifact carries is proved on the real binary rather than on a fixture.

## What It Proves

`scripts/native-host-artifact.node-test.mjs` proves the identity logic with
synthetic binaries.  A fixture can be right about the logic and still say
nothing about the product:  the packager could fail to export the source, the
universal assembly could drop a slice, the archive could carry a stale
executable, or the stamp could be embedded in a way the binary itself cannot
read back.

This smoke runs the real path:

| Property | How | Failure cause |
|---|---|---|
| The real packager produces a real archive | `scripts/package-native-host.mjs --unsigned-dev` over the committed source, in a temporary directory outside the repository | the packager's own refusal, verbatim |
| The bytes are the bytes the receipt names, and that is proved before anything runs | the unpacked executable and the archive are hashed and compared with the receipt, and the executable is run only when both comparisons succeed, so substituted bytes are never executed | `hashes to` |
| The packaged executable reports the identity the receipt claims | the archive is opened again and `payload/bin/BotFleetNativeHost --identity` is run; the answer is compared with the receipt field for field | `identity <field> differs` |
| The receipt describes this commit | the receipt's source commit and build number are compared with the commit that was packaged | `the receipt says source`, `the receipt says build` |
| The artifact is the unsigned one and says so | the receipt must say `NOT DISTRIBUTABLE`, must not be distributable, must carry the `arm64` slice and must not claim a verified signature | `not distributable`, `no arm64 slice` |
| The receipt and the reported identity are what the smoke expects | both go through a schema at the boundary, and every field the smoke reads is checked there | `does not match the expected shape` |

## The Optional Host Is Independent Of The Standard GUI Release

The optional native headless host ships on a path of its own, and it can never
be the reason the standard signed GUI release fails.

The GUI release is `native-mac-release.yml`.   It archives the app, signs it,
notarizes it, staples it, packages the ZIP and the DMG from the stapled app
and attaches the asset set to a draft.   The three jobs that do that,
`mac-native`, `assemble` and `draft`, do not build the optional host, and none
of them needs a job that does.   The separation is held by
`scripts/native-host-independent-path.node-test.mjs`, on the parsed
workflow:   no GUI release job names the host packager or the host smoke, by
any of their spellings;   nothing in the GUI release chain `needs` a host job,
so a skipped or failed host job can neither skip nor fail the release;   and
the standard test chain never grows the host's real packaging build.   Each of
those assertions was checked against a workflow deliberately broken in that
one way.

The host's own path is opt-in and separate.  `pnpm smoke:native-host-package`
runs `scripts/native-host-package-smoke.mjs`, which packages the checkout with
`scripts/package-native-host.mjs`, opens the archive again and asks the
packaged executable for its own identity.  The packager writes its own receipt,
`artifact.json`, beside the artifact, and it refuses to overwrite a receipt it
already wrote.

What the standard test chain keeps is the identity proof over synthetic
binaries, `scripts/native-host-artifact.node-test.mjs`.  That proof costs a
synthetic fixture and says nothing about a shipped artifact, so it belongs in
the chain;  the real build does not, and it stays behind its own command.

What stays with the owner, and is claimed by none of this:   the Developer ID
identity and its grant, the notarization credentials, the installed and
pre-login acceptance on a real Mac, the service credentials, and the decision
to publish a release.   The host's artifact is built by the same dispatch, in
a job of its own, when the `native-host` input is ticked.   The next section
says what that job does and what it proves.

## The Signed Artifact In The Native Release

`Native Mac Release` builds the host only when its **native-host** input is
ticked, and it builds it in a job of its own, `mac-native-host`.   That job
checks out the commit `prepare` pinned, imports the same Developer ID
certificate into a throwaway keychain, and runs
`scripts/package-native-host.mjs` with the build `prepare` planned, so the
disk image carries the same source commit, the same build number and the same
signing team as the app beside it.   The packager builds both slices from an
export of the committed `ios` tree, stamps the binary, signs it and verifies
that signature itself, then notarizes, staples and checks the image.   It
reads the notarization credentials itself, with the lane's own read token and
from the folder that token covers.   It refuses a dirty checkout for a
distributable build, which is why the job runs on a clean checkout of its own
and writes nothing into it.

| Property | How | Failure Cause |
|---|---|---|
| The receipt names the pinned commit and build | `scripts/verify-native-host-artifact.mjs release` reads `artifact.json` and refuses another source commit, another build, or anything but a Developer ID distribution | `another commit or build than the pinned ones` |
| The bytes on disk are the bytes the receipt names | the image is hashed again and compared with the receipt's `artifactSha256` | `does not hash to the digest the receipt names` |
| The mounted image holds the executable the receipt names, with its signature intact | the image is mounted read-only and `verifyNativeHostArtifact` runs on `bin/BotFleetNativeHost` inside it: both slices, both real signatures, the team, the hardened runtime, the stamp and the exact file set | `Native host artifact verification refused.` |
| The image never stays mounted | the detach runs on every path out, and the mount point is removed only after the detach is confirmed twice, by `hdiutil`'s exit status and by the file system, and then with whatever was left inside it | a failed detach fails the job |
| What is attached is what was verified | the attach job downloads the artifact, hashes it again against the digest the macOS job reported, and refuses a release that is no longer a draft | `not the one the build job verified` |

A green run prints, from the macOS job,
`Notarized container; installation is separate: BotFleetNativeHost-0.1.0-<build>.dmg`
and then `PASS native host artifact ... mounted and verified.`   With
**draft** ticked as well, the attach job ends with
`native host artifact on v<version>-<build>-native: ...`, listing the asset
beside the app's.   The Actions artifact is `native-mac-host-release` and
holds the disk image with its receipt;   only the disk image is attached to
the release.

The job produces and publishes the artifact and does nothing else.   It never
runs the packaged executable, installs nothing, registers no LaunchAgent or
LaunchDaemon and touches no live host;   the test that holds the GUI release
independent holds this too.   A failure inside the job fails the job:   no
step there may continue past an error, and nothing is uploaded before the
verifier passes.

What a local run can prove, and what it cannot:   on a Mac, the unsigned
development package, the verifier over it, and the verifier over a locally
built read-only image are the recipe under Running It.   The Developer ID
signature, the notarization and the stapling need the certificate and the
notarization credentials, which exist only in the release lane, so the hosted
run is their receipt.

## Running It

It needs macOS and the Swift toolchain, because the package is built there:
the packager exports the committed `ios` directory and builds the host for
`arm64` and `x86_64` from that export.

```sh
pnpm smoke:native-host-package
```

The build is a cold release build of both slices, so a first run takes a while.
`--keep` leaves the temporary directory in place so the archive can be looked
at; without it the directory is removed when the run ends.

The rules the smoke applies are proved on every host, macOS or not, by
`scripts/native-host-package-smoke.node-test.mjs`, which the native-release
chain runs.  That file drives the macOS branch too:  a stand-in for the
packager writes a receipt and an archive, the archive is opened again, the
executable inside it is asked for its identity, and the receipt's build and
the archive's own bytes are checked against what the smoke claims.  The
order is proved as well:  a fixture swaps the receipt's binary digest and
asserts that the executable is never executed, and a fixture removes an
identity field from both sides and asserts that the difference is still
reported.

### Verifying A Package With The Release Verifier

`scripts/verify-native-host-artifact.mjs` is what the release workflow runs
over the packaged host.   It can be run by hand against an unsigned
development package, on the unpacked payload and through a locally built,
read-only image, which is as far as a Mac without the release certificate can
take it.   The build is the commit's own Central stamp.

```sh
work="$(mktemp -d "${TMPDIR:-/tmp}/bf-native-host.XXXXXX")"
build="$(TZ=America/Chicago git log -1 --date=format-local:%Y%m%d%H%M --format=%cd)"
source="$(git rev-parse HEAD)"
node scripts/package-native-host.mjs --repo-root . --output "$work/package" --build "$build" --unsigned-dev
node scripts/verify-native-host-artifact.mjs payload "$work/package/payload" \
  --source "$source" --build "$build" --unsigned-development
hdiutil create -volname BotFleetNativeHost -srcfolder "$work/package/payload" -ov -format UDZO "$work/local.dmg"
mkdir "$work/mnt"
hdiutil attach -readonly -nobrowse -mountpoint "$work/mnt" "$work/local.dmg"
node scripts/verify-native-host-artifact.mjs payload "$work/mnt" \
  --source "$source" --build "$build" --unsigned-development
# The verifier's own detach removes nothing while the image is on the mount point.
node --input-type=module -e 'import { unmountDiskImage } from "./scripts/verify-native-host-artifact.mjs";
  unmountDiskImage(process.argv[1], { detached: () => true });' "$work/mnt" && exit 1
test -d "$work/mnt/bin"
# After a detach, it removes the mount point with anything left inside it.
hdiutil detach "$work/mnt"
touch "$work/mnt/left-behind"
node --input-type=module -e 'import { unmountDiskImage } from "./scripts/verify-native-host-artifact.mjs";
  unmountDiskImage(process.argv[1], { detached: () => true });' "$work/mnt"
test ! -e "$work/mnt"
rm -rf "$work"
```

Each verifier call answers
`PASS native host payload: source <commit>, build <build>, arm64+x86_64, unsigned-development.`
or exits 1 with a refusal and no pass line.   A build or commit other than the
stamp's is refused, and so is the same payload held to the distributable
standard, because the real signature inspector finds nothing to trust in an
unsigned binary.

## What The Receipt Has To Say

A run on a real Mac is evidence only when it carries the facts that make it
checkable:  the PASS line, the exact checkout SHA, the macOS version, the
architecture and the Swift version.  The PASS line carries the source commit
in full, because the receipt that holds it is deleted with the temporary
directory unless `--keep` is passed;  with `--keep` the whole receipt stays at
`<temp>/package/artifact.json`, and `git rev-parse HEAD` gives the checkout
SHA on its own.

```sh
sw_vers
uname -m
swift --version
```

## What It Never Does

It installs nothing, signs nothing, notarizes nothing, starts nothing, reads
no Keychain item, touches no service credential, publishes nothing and writes
no installed path.  The archive is unsigned on purpose:  its receipt says
`NOT DISTRIBUTABLE`, and that is what the smoke checks.
