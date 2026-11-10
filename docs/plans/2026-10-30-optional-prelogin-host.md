# Optional Pre-Login Host: Design

Status: design proposal for BF-2597.  This document defines an optional native macOS headless host that can start before a user logs in; it does not claim that a native host executable, daemon, installer, or deployment exists.

## Owner Ruling And Scope

Jay’s ruling for BF-2531 is: “should be able to do so before login but optionally” (chat `01a18e51-fa5e-77a3-8d7b-b5baa414ab98`, recorded in [Zulip message 636401337](https://simplewithus.zulipchat.com/#narrow/near/636401337)).  In this chat the owner added: “used to have some things for Socratic Trade, or actually maybe for UM and CT too, working before login but then hosted by server. option 2”.  The selected identity direction is a dedicated service identity, separate data, and an approved service-accessible credential design.  The verified repository evidence below distinguishes those hosted workers from current per-user Mac LaunchAgents.  This selects capability and service architecture, not automatic login, a security setting change, or permission to install a daemon.  No AutoLoginUser or FileVault change is part of this design.

The GUI app remains the interactive BotFleet surface.  A separate headless process may own host services before login, while the GUI later attaches locally and provides capabilities that require a logged-in desktop.  A service manager, shared state, credential policy, native service executable, and installation path still need implementation and review.

## Verified Starting Point

- `ios/MacApp/BotFleetMacApp.swift` is a SwiftUI/AppKit application.  Its window appearance handler wires the menubar and window, then calls `MacSession.launch()`.
- `ios/MacApp/MacSession.swift` connects to the loopback harness at `127.0.0.1:8799`, starts the optional companion listener, and owns UI, window, notification, voice, workspace, and CUA permission behavior.  It is not a headless composition root.
- `ios/Sources/CompanionCore/NativeRuntimeServices.swift` is opt-in: construction starts no listener or polling.  `activate()` recovers waits and can start polling, but the current composition requires workspace and process-ownership sources, so it is not yet proven headless-safe.
- `ios/Sources/CompanionCore/NativeCompanionServer.swift` is the native listener boundary.  `MacSession` lazily constructs it with a separate SQLite store under `<dataDir>/native/companion.sqlite`.
- `ios/Sources/CompanionCore/MacLifecycleControls.swift` defaults lifecycle files to `$HOME/.botfleet`, unless an absolute `OMB_DATA_DIR` is set.  The tracked `scripts/launchd/app.botfleet.server.plist` and `app.botfleet.companion.plist` are per-user LaunchAgents with `HOME=/Users/jay`; they do not establish a pre-login native host.
- `MacSession.handleAppTermination()` applies the existing `persistOnExit` policy (`ios/MacApp/MacSession.swift:896-912`); the default is `true` (`ios/Sources/CompanionCore/MacLifecycleControls.swift:19`).  The explicit “Shut Down Server & Local VM” action calls `shutDownServerAndLocalVM()` (`ios/MacApp/BotFleetMacApp.swift:139`, `MacSession.swift:865-889`), which requests the fenced stop first and writes the deliberate-stop marker only after a successful response (`MacLifecycleControls.swift:519-590`).
- `docs/plans/2026-10-29-botfleet-control-after-node.md` describes a LaunchDaemon as unable to provide WindowServer/TCC desktop automation.  Its first-login-only recommendation predates and is superseded by the BF-2531 owner ruling above.
- `docs/plans/2026-10-29-native-server-mode.md` says `MacSession` is a client today and native worker/runtime wiring remains future work.  Its proposed temporary Node worker bridge is not the target native host.

## Related Service Patterns Checked

- **Socratic.Trade:** production is hosted on Coolify (`Socratic-Trade/README.md`, `Socratic-Trade/docs/deployment.md`).  `Socratic-Trade/instrumentation.ts` calls `startServerBackgroundWorkers()`, and `Socratic-Trade/src/lib/background-worker-startup.ts` starts process-level workers in production.  This verifies server-hosted background work, not a local pre-login macOS daemon.
- **Usage Monitor:** `Usage-Monitor/docs/runbooks/mac-collectors-install.md` installs Mac collectors in a copied runtime and uses per-user `~/Library/LaunchAgents`; its subscription wrapper reads the login Keychain.  The repo also documents separate Coolify-hosted services.  These sources do not establish a Mac pre-login daemon pattern.
- **Congress.Trade:** `Congress.Trade/services/scan-cpu-worker/README.md` documents a Linux/Coolify worker, while `Congress.Trade/services/vision-worker/README.md` installs the Mac worker as a per-user LaunchAgent and requires the owner’s Grok CLI login.  This verifies a server-hosted worker alongside an interactive-user Mac worker, not a Mac pre-login daemon.

These precedents support hosting background work in a service process and attaching a desktop client where needed.  They do not prove that any prior ST, UM, or CT Mac worker ran before login as a LaunchDaemon.  The prior local service type for any unspecified historical pre-login work remains unknown.

A filtered, read-only check of `MAC-LOCAL-PROCESSES.md` found Usage Monitor LaunchAgent rows and Congress.Trade `pm2` rows, but no matching row identified a LaunchDaemon or asserted pre-login operation.  The Socratic.Trade service type is not stated in its matching rows.  This inventory does not establish the owner’s remembered pre-login arrangement, so its exact host and service type remain unknown.

## Architecture And Ownership

Use one native service executable with two explicit lifecycle phases:

1. **Headless host:** starts the service API, persistent job/runtime state, health reporting, and only work whose required capabilities are headless-safe.  It owns the runtime database and job dispatch while active.
2. **Interactive attachment:** the signed-in BotFleet GUI connects over a local-only authenticated channel to that owner, supplies desktop capability availability, and presents controls/status.  It must not start a second service, open a second writer, or independently dispatch the same job.

The first code slice should create a headless-safe composition root in `ios/Sources/CompanionCore` and make dependencies explicit.  It should separate service lifecycle from `MacSession`, and model attachment as capability registration rather than moving service ownership.  The native executable and any launchd installer come later; this design does not imply that SwiftPM currently builds such an executable.

### Headless Capability Allowlist

Allow only capabilities that do not require a logged-in desktop: local database access under the selected data root; service health and status; authenticated local IPC; queue inspection and durable scheduling; provider work only when approved credentials are available to the service identity; and subprocess work whose declared requirements do not include the desktop.

Treat screen capture, Accessibility/UI automation, `NSWorkspace` desktop state, user notifications, microphone/audio capture, window management, and user-session Keychain items as interactive capabilities.  Before attachment, represent these as unavailable with an explicit `waitingForLogin` reason.  A job requiring one remains queued or held with that reason; it is never silently downgraded to a different capability set.

## Service Identity And Credentials

**Selected:** run the optional headless process as a dedicated service identity with a service-owned data root separate from the interactive user’s `$HOME/.botfleet`.  Do not share the interactive database, stop-marker directory, login Keychain, or file ownership across identities.  The exact service account, data-root location, permissions, and migration procedure are implementation details that must be specified and reviewed before installation.

Provider credentials must use an owner-approved service-accessible credential design scoped to this service identity.  The owner selected that design direction; this document does not invent or provision the credential mechanism, authorize reading another store, or authorize a secret transfer.  Until the approved credential interface is available and unlocked for the service, affected work reports `credentialsUnavailable` and remains held.  Do not copy interactive Keychain items, prompt at the login window, or silently fall back to a different credential source.

The same-user design was considered and is not selected.  It would couple unattended service state to the interactive home and login Keychain, contrary to the owner’s selected separate-service model.

## Lifecycle Contract

| Event | Headless owner | Interactive GUI | Required visible state |
|---|---|---|---|
| Boot, option disabled | Does not start | Starts at normal user login only | `stopped` until login launch |
| Boot, option enabled | Starts only after macOS and the configured data volume are available and unlocked; acquires the exclusive runtime lock and opens its separate service data root | Not running before login | `starting`, then `headlessReady` or a concrete blocked/error state |
| OS or data volume locked/unavailable | Does not start against a missing or locked root and does not attempt to unlock it | May start only after normal macOS disk unlock and login | `waitingForVolume` or `waitingForLogin`; no claim that the service bypasses FileVault or disk unlock |
| Service credential unavailable | Keeps only credential-independent functions alive; does not retry by reading another store | GUI attachment does not silently transfer credentials | `credentialsUnavailable`; affected work held with reason |
| GUI login and attach | Remains the sole service/data owner; accepts an authenticated local attachment and current interactive capability set | Attaches, displays `headlessReady` plus interactive capability state | `attached`; desktop-only work is eligible only after capability proof |
| GUI logout or detach | Releases GUI-only capability registration; may continue under the selected persistence policy | Detaches and stops desktop work cleanly | `headlessReady` or `waitingForLogin` |
| GUI Quit | Applies the existing `persistOnExit` policy; with the default `true`, the server remains running, while `false` requests fenced shutdown and a deliberate-stop marker | Terminates after shutdown handling completes | `headlessReady` if persistence keeps the service running, or `stoppedByOwner` after successful shutdown |
| Explicit Stop Server | Always requests the fenced server shutdown; on success writes the deliberate-stop marker and releases the runtime lock.  An in-flight-work refusal leaves the server running and reports the refusal. | Stop command routes to the owner; GUI does not start a competing service | `stoppedByOwner` remains across reboot until explicit Start |
| Owner Start | Clears the stop marker, validates the configured root, acquires ownership, and starts | GUI reconnects to the owner | `starting`, then current service state |
| Upgrade | Stops admission, drains or fences active work, checkpoints/closes the database, switches to a verified immutable release, then restarts | Reattaches only after service protocol/version check passes | `upgrading`, then `headlessReady`; failure rolls back and reports `upgradeFailed` |

One exclusive lock must cover the runtime database and dispatch ownership.  On lock contention, the second process must exit with a readable `ownerAlreadyRunning` status; it must not bind the service port, migrate schema, or start jobs.  The GUI attaches to the running owner instead of owning a second database connection with write authority.

## Stop Marker, Persistence, And Upgrade

Store the new service’s marker and exclusive lock in its separate service-owned data root.  Explicit Stop Server always uses a fenced shutdown and persists the stop marker only after success; a refusal leaves the process and work intact.  GUI Quit follows the existing `persistOnExit` setting: the default `true` keeps the service running, and `false` requests the fenced shutdown path.  Window close follows the same persistence setting and does not itself terminate the app.  Starting the optional host before login never overrides a deliberate-stop marker.  Reboot does not clear a deliberate Stop.  Explicit Start or an owner-confirmed startup-policy change clears it.

Service installation must be opt-in, reversible, and separate from the app login item.  Before enabling it, validate executable signature/version, selected identity, absolute writable data root, ownership and permissions, free space, schema compatibility, local-only IPC permissions, and absence of another service owner.  Write the launchd definition atomically, retain the previous definition and release, then enable and start.  On failed health or version handshake, stop the new process, restore the previous definition and release pointer, and leave a diagnostic status; never delete user data as rollback.

Do not reuse the current Node LaunchAgent plists or `scripts/botfleet-server-start.sh` as a native daemon installer.  They are tied to the existing Node release layout, `$HOME/.botfleet`, launchd environment, and harness lifecycle markers.

## Acceptance Evidence

### Isolated Before Any Live Installation

- A fixture launches the headless executable with a temporary data root and fake credential provider.  It proves a single process owns the lock/database, reports health before GUI attachment, and rejects a second owner without dispatching duplicate work.
- A fixture with no service credential reports `credentialsLocked`, holds only credential-dependent work, and never reads outside the supplied test root.  A later fake unlock allows the same owner to resume through an explicit state transition.
- A fixture proves desktop-only work reports `waitingForLogin`, becomes eligible only after an authenticated interactive attachment grants the required capability, and returns to waiting after detach.
- Lifecycle fixtures cover opt-in off/on, persistent Stop, explicit Start, interrupted upgrade rollback, incompatible service/app versions, and no double dispatch across GUI attach/detach.
- Installer tests use a temporary launchd definition and fake service executable.  They verify validation failures leave the prior service definition and release untouched, and a failed new health check restores the prior version.

### Eventual Live Acceptance

Only after owner decisions, code review, signed packaging, and a separately authorized installation: verify a cold boot with the option off does not start the host; with it on, the headless status is healthy before login; locked credentials are visibly blocked; login attaches the GUI without a second listener or database owner; desktop work remains held until interactive capability checks pass; explicit Stop remains stopped after reboot; and an interrupted upgrade rolls back to the last healthy release.  Record the tested Mac OS version, selected identity, option state, and service version without recording credentials or private host paths.

## Selected Direction And Remaining Work

The owner selected the dedicated service identity, separate data root, and approved service-accessible credential direction.  This is an architectural choice only; account provisioning, data migration, credential mechanism, code, packaging, installation, and any live acceptance remain future work.  Neither this selection nor the optional pre-login setting enables automatic login or changes FileVault.  A pre-login service starts only after macOS and its configured data volume are available and unlocked.
