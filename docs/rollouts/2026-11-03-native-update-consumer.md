# Native Update Consumer (BF-2628)

The native Mac target links the exact Sparkle 2.9.6 binary package.  `NativeMacUpdater` retains its standard updater controller, while `NativeUpdateService` exposes observable check, availability, download and failure state through an injected driver.  Sparkle owns its scheduler, preference keys, download verification, installation and relaunch.  This change adds no independent update timer and no lifecycle override.

The service uses the existing six-hour automatic-check policy and three consecutive same-class failures' twenty-four-hour backoff.  Manual checks bypass and reset automatic backoff without moving the automatic-check clock.  Only the automatic-check clock and bundle fingerprint persist across app launches; a new service clears failure backoff, matching the Electron restart policy.  Repeating `start()` on the same service preserves its backoff.  Failure counts saturate at the backoff threshold, and legacy cached failure fields are ignored.  A bundle fingerprint change bypasses the old bundle's throttle.  A due automatic check runs once immediately after updater start, only with automatic checks enabled; subsequent scheduling remains Sparkle's.  A refused scheduler tick never counts as a fresh failed attempt.  Sparkle's no-update result and cancelled installation authorization are ordinary completed checks; cancelling a download clears its visible progress state.

## Configuration And Composition

`ios/project.yml` generates `SUFeedURL` and `SUPublicEDKey` from the public build settings `BOTFLEET_NATIVE_UPDATE_FEED_URL` and `BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY`.  The native release workflow passes the correspondingly named GitHub repository variables; the local packaging script passes explicitly supplied environment values.  Both settings default to empty.  No private signing key is read by the app or this configuration path.

Infisical remains the canonical source of truth for the public feed URL and verification key as well as signing credentials.  The GitHub variables and local environment fields are optional build mirrors of verified canonical configuration, never independently authoritative settings.  Before activation, the release owner must verify each mirror against the existing authorized Infisical configuration and signing pipeline.  This change neither provisions those mirrors nor establishes that their canonical values are available.

The service requires an HTTPS feed URL without embedded credentials or a fragment, plus a canonical base64 Ed25519 public key of 32 bytes.  Missing or invalid metadata leaves updates unavailable and constructs no network driver.  A syntactically valid key is not evidence of its provenance: the release owner must verify the public key matches the existing authorized signing pipeline and that the configured native appcast is the maintained feed.  There is no guessed URL, key, Electron-feed fallback or new key generation.

The Mac app composition must retain one `NativeMacUpdater`, invoke `updater.service.start()` once at startup, and install `NativeUpdatesCommands(service: updater.service)` in its command groups.  The command observes live availability and displays the safe status as help text.  Automatic checks can be changed explicitly through `service.setAutomaticChecksEnabled`; Sparkle retains that preference.  The composition remains a coordinated handoff to its current owner, and the adapter alone is not evidence that these calls are installed.

The upstream distribution's copyright and license text is included as the `Sparkle-LICENSE.txt` app resource, with whitespace formatting only.  Sparkle is linked only to the native Mac app target, not the phone or headless host.

## Validation Boundary

Focused isolated fixtures cover rejected configuration, absence of driver construction, startup failure, manual and automatic admission, preference changes, class-specific backoff, restart recovery with the six-hour clock preserved, rejected-tick handling, bundle replacement, download state and corrupt preference recovery, including legacy maximum-integer and negative failure counts.  They use an injected memory store and fake driver, never the installed app or user defaults.

After primary source review, the final production snapshot `42f29f3dbb154fb7d058d82899fd932cfdcede01` passed one complete `swift test --package-path ios --jobs 2` run: 1,182 XCTest cases and 364 Swift Testing cases.  Unsigned `xcodebuild` builds of `BotFleetMac` for generic macOS and `BotFleet` for generic iOS Simulator also passed, sequentially with two build jobs.  The Mac artifact contains both x86_64 and arm64 slices, the embedded Sparkle framework and its license resource.  All ten changed iOS component hashes matched the source lane before validation and remained identical after all three checks.  The restart-policy correction separately passed all 20 focused updater XCTest cases.  These results supersede the earlier predecessor-snapshot validation boundaries, while preserving their failure receipts below.

One complete Linux `pnpm typecheck && pnpm test` gate passed with process-local umask 022, `VITEST=true` and the container runtime disabled: 12,658 Vitest cases passed, 22 skipped, across 744 passing files, followed by every downstream Node stage.  Later edits touched Swift only; the Node inputs remained unchanged.  Release workflow/appcast fixtures separately passed 36 cases, and lint passed at the unchanged 4,867-warning baseline.

Failure receipts remain preserved.  The initial adapter compile used two Objective-C constant names instead of their Swift enum cases.  An initial full Swift run failed two MCP fixtures whose redirect/error checks raced 200 ms and 30 ms deadlines; those checks now use the production default while a dedicated short-deadline assertion remains.  A later full run failed an engine recovery fixture that started its SIGKILL stopwatch before process launch; it now requires a successful signal and measures from that call, retaining the exact two-second limit and terminal/next-turn assertions.  No production MCP or process-supervisor behavior was changed by these fixture corrections.

No native app was installed or launched, no update was downloaded or applied, and no signing credentials or live services were changed.  Verified public feed/key activation, the composition handoff, a signed/notarized release and an installed previous-build Sparkle update remain distinct completion boundaries.

## Upstream References

- [Sparkle Setup](https://sparkle-project.org/documentation/)
- [Programmatic SwiftUI Setup And Scheduling Expectations](https://sparkle-project.org/documentation/programmatic-setup/)
- [Pinned Sparkle 2.9.6 Package](https://github.com/sparkle-project/Sparkle/blob/2.9.6/Package.swift)
- [Updater Delegate Contract](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html)
