# TestFlight and App Store release

The app is native Swift and uses XcodeGen; EAS commands do not apply.

## One-time Apple setup

1. Enrol in the Apple Developer Program.
2. Register the bundle IDs `app.botfleet.ios` and `app.botfleet.ios.widgets` (already in `project.yml`).
3. Create the matching app in App Store Connect with the name **BotFleet**, primary category **Productivity**, and a unique SKU.
4. Use the existing Apple Distribution identity (team `CC8UTF7ATG`).  Hosted ships use automatic signing and do not install a new provisioning profile.
5. Add the review contact details in App Store Connect; do not commit private contact data or App Store Connect keys.

## Hosted TestFlight (primary)

Merges that touch `ios/**` (or the ship scripts) run `.github/workflows/ios-ship.yml` on GitHub-hosted `macos-latest`.  The job maps existing `APPLE_API_*` and `IOS_CERT_*` repository secrets, then calls `scripts/ios-ship-testflight.sh` with no extra flags.  Marketing stays on the `1.0.N` train (`+1` on every rebuild).  `CURRENT_PROJECT_VERSION` is UTC `YYYYMMDDHHMM`.  Do not mint a new key.  Do not install a new provisioning profile (automatic signing).

The Mac wrapper remains a fallback when the hosted job cannot run.  It prefers `scripts/ios-fleet/`, then a local `ios-fleet` checkout (for example `~/apps/ios-fleet`).

## Before every upload

1. Run `swift test` from `ios/` and the repository test suite.
2. Generate the Xcode project with `xcodegen generate` from `ios/` (hosted ships do this in CI; the `.xcodeproj` is gitignored).
3. Team `CC8UTF7ATG` is already set as `DEVELOPMENT_TEAM` in `project.yml`.
4. Hosted ships stamp `MARKETING_VERSION` `1.0.N` (`+1` per rebuild) and `CURRENT_PROJECT_VERSION` as UTC `YYYYMMDDHHMM`.  Do not hand-edit those for a hosted upload.
5. Archive a generic iOS device build and validate it in Xcode Organizer only when using the manual fallback.
6. Upload to App Store Connect and distribute to internal TestFlight testers first (hosted ships upload in CI).
7. Complete a real-iPhone pass for pairing, Bonjour permission, Keychain restore (including an install upgraded from an OpenMausBot-era build:  its token moves from the old keychain service on first launch and the phone must stay paired), Tailscale, optional hosted HTTPS, approvals, background/foreground reconciliation, sign-out/revocation, and transcript sharing.
8. After internal testing, submit to an external TestFlight group before App Review.

## App Store Connect

- Copy the localized text from `en-US/`.
- Use `privacy-answers.md` and verify it still matches the binary.
- Use `review-notes.md`, adding a real review contact in App Store Connect.
- Support URL: `https://github.com/jaywedgeworth22/BotFleet/issues`
- Privacy policy URL: `https://github.com/jaywedgeworth22/BotFleet/blob/main/docs/ios-privacy.md`
- Choose manual release for 1.0; enable a phased release after the first production build is stable.

The unsigned simulator CI proves compilation, not distribution signing.  Hosted TestFlight ships run from `.github/workflows/ios-ship.yml` on `macos-latest` when `ios/**` (or the ship scripts) land on `main`.  Signing uses the existing repository Actions secrets.  Hosted ships use the fleet script default interval (no extra flags).
