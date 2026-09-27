# Issue #285 — Complete Desktop Release Feed

## Problem

The desktop auto-update feed is incomplete.  As of v0.1.38, the public release contains only DMG artifacts and no feed file.  An installed app checking for updates cannot find the feed and reports no updates available.  This blocks desktop users from receiving security updates and new features via the auto-updater.

## Users

- Desktop users (macOS, Windows, Linux) with BotFleet v1.0.30 or later installed
- Users relying on "Check for updates" in the application menu
- The release automation running on GitHub Actions

## Constraints

- The auto-update feed must be deterministic: the same source commit always produces the same feed bytes and hashes
- Feed must list both macOS architectures (arm64 and x64) separately with blockmaps for resume
- Windows and Linux feeds must include all required artifacts (installer, AppImage, Debian package)
- The release workflow uses GitHub's short-lived token; no personal access tokens or long-lived secrets
- Blockmaps must be valid gzip v2 maps with correct BLAKE2b-144 chunk hashes
- Developer ID signing certificate values come from Infisical or GitHub secrets; workflow fails closed on missing credentials
- The update version in `package.json` must be bumped before running the release workflow
- No manual feed editing after generation; all feeds are machine-generated
- Desktop version advances from 1.0.30 to 1.0.31 to enable discovery by running 1.0.30

## Acceptance

1. Running the Release workflow produces a `latest-mac.yml` feed file alongside the arm64 and x64 ZIP artifacts (plus `.blockmap` files)
2. The macOS feed lists exactly two ZIP entries with correct artifact names, SHA-512 hashes, blockmaps, and sizes
3. Running the Release workflow produces `latest.yml` for Windows with the setup.exe and its blockmap
4. Running the Release workflow produces `latest-linux.yml` for Linux with both the AppImage and Debian package entries and their hashes
5. Feed files are generated deterministically: the same source commit produces byte-for-byte identical feeds
6. The workflow validates exact feed versions, artifact names, SHA-512 values, byte sizes, blockmaps, and stable download aliases for all three platforms
7. Blockmap validation confirms each gzip v2 map has complete coverage and correct BLAKE2b-144 chunk hashes against its installer
8. On error during Mac certificate loading, assembly is skipped and no draft or public release is created
9. The workflow refuses to overwrite an already-published version
10. Feed files are uploaded to the GitHub Release alongside artifacts, ready for electron-updater consumption
11. An installed app running v1.0.30 can discover and install v1.0.31 when it checks for updates

## Out of Scope

- Creating or publishing releases for platforms other than macOS, Windows, and Linux
- Installing v1.0.31 on actual devices (owner-only action; not part of this issue)
- Changes to the bundler or packaging tools
- Notarization workflow (covered in separate rollout)
- Auto-update testing against live release feeds (covered by release workflow tests)
- Signing with anything other than the Developer ID certificate or GitHub Actions

## Related Issues

- Follows from the release workflow validation work
- Prerequisite for v1.0.31 public ship
- Linux feed correction also addressed in this issue's follow-up (September 12)
