# Optional Pre-Login Host: Design

Status: design proposal for BF-2597.  This document defines an optional native macOS headless host that can start before a user logs in; it does not claim that a native host executable, daemon, installer, or deployment exists.

## Owner Ruling And Scope

Jay’s ruling for BF-2531 is: “should be able to do so before login but optionally” (chat `01a18e51-fa5e-77a3-8d7b-b5baa414ab98`, recorded in [Zulip message 636401337](https://simplewithus.zulipchat.com/#narrow/near/636401337)).  This selects capability, not automatic login, a security setting change, or permission to install a daemon.  No AutoLoginUser or FileVault change is part of this design.

The GUI app remains the interactive BotFleet surface.  A separate headless process may own host services before login, while the GUI later attaches locally and provides capabilities that require a logged-in desktop.  A service manager, shared state, credential policy, native service executable, and installation path still need implementation and review.

## Verified Starting Point

- `ios/MacApp/BotFleetMacApp.swift` is a SwiftUI/AppKit application.  Its window appearance handler wires the menubar and window, then calls `MacSession.launch()`.
- `ios/MacApp/MacSession.swift` connects to the loopback harness at `127.0.0.1:8799`, starts the optional companion listener, and owns UI, window, notification, voice, workspace, and CUA permission behavior.  It is not a headless composition root.
- `ios/Sources/CompanionCore/NativeRuntimeServices.swift` is opt-in: construction starts no listener or polling.  `activate()` recovers waits and can start polling, but the current composition requires workspace and process-ownership sources, so it is not yet proven headless-safe.
- `ios/Sources/CompanionCore/NativeCompanionServer.swift` is the native listener boundary.  `MacSession` lazily constructs it with a separate SQLite store under `<dataDir>/native/companion.sqlite`.
- `ios/Sources/CompanionCore/MacLifecycleControls.swift` defaults lifecycle files to `$HOME/.botfleet`, unless an absolute `OMB_DATA_DIR` is set.  The tracked `scripts/launchd/app.botfleet.server.plist` and `app.botfleet.companion.plist` are per-user LaunchAgents with `HOME=/Users/jay`; they do not establish a pre-login native host.
- `docs/plans/2026-10-29-botfleet-control-after-node.md` describes a LaunchDaemon as unable to provide WindowServer/TCC desktop automation.  Its first-login-only recommendation predates and is superseded by the BF-2531 owner ruling above.
- `docs/plans/2026-10-29-native-server-mode.md` says `MacSession` is a client today and native worker/runtime wiring remains future work.  Its proposed temporary Node worker bridge is not the target native host.

## Architecture And Ownership

Use one native service executable with two explicit lifecycle phases:

1. **Headless host:** starts the service API, persistent job/runtime state, health reporting, and only work whose required capabilities are headless-safe.  It owns the runtime database and job dispatch while active.
2. **Interactive attachment:** the signed-in BotFleet GUI connects over a local-only authenticated channel to that owner, supplies desktop capability availability, and presents controls/status.  It must not start a second service, open a second writer, or independently dispatch the same job.

The first code slice should create a headless-safe composition root in `ios/Sources/CompanionCore` and make dependencies explicit.  It should separate service lifecycle from `MacSession`, and model attachment as capability registration rather than moving service ownership.  The native executable and any launchd installer come later; this design does not imply that SwiftPM currently builds such an executable.

### Headless Capability Allowlist

Allow only capabilities that do not require a logged-in desktop: local database access under the selected data root; service health and status; authenticated local IPC; queue inspection and durable scheduling; provider work only when approved credentials are available to the service identity; and subprocess work whose declared requirements do not include the desktop.

Treat screen capture, Accessibility/UI automation, `NSWorkspace` desktop state, user notifications, microphone/audio capture, window management, and user-session Keychain items as interactive capabilities.  Before attachment, represent these as unavailable with an explicit `waitingForLogin` reason.  A job requiring one remains queued or held with that reason; it is never silently downgraded to a different capability set.

## Service Identity And Credentials

**Recommendation:** run the optional headless process as the same macOS user that owns BotFleet’s current data, but do not assume the login Keychain is unlocked at boot.  The service must report a distinct blocked state when a required credential is unavailable; it must not read another user’s store, copy credentials, prompt before login, or fall back to a different credential source.

Two identity options remain for the owner:

- **Same user (recommended):** preserves the existing `$HOME/.botfleet` ownership and avoids a service-account data migration.  Credentials that require the locked login Keychain stay unavailable until unlock, and work needing them reports `credentialsLocked` or `waitingForLogin`.
- **Dedicated service identity:** isolates service files and permissions, but requires an explicit data migration, file ownership policy, and a separately approved service-accessible credential design.  It does not inherit the interactive user’s Keychain or BotFleet state automatically.

No identity option authorizes an alternate secret store.  If unattended credential access is a requirement, the owner must explicitly choose and approve the service credential mechanism before implementation.

## Lifecycle Contract

| Event | Headless owner | Interactive GUI | Required visible state |
|---|---|---|---|
| Boot, option disabled | Does not start | Starts at normal user login only | `stopped` until login launch |
| Boot, option enabled | Starts once under the selected identity, acquires the exclusive runtime lock, opens the selected data root, and exposes local health | Not running before login | `starting`, then `headlessReady` or a concrete blocked/error state |
| Service needs a locked credential | Keeps only credential-independent functions alive; does not retry by reading other stores | On login, may unlock its own user context and offer explicit attachment | `credentialsLocked`; affected work held with reason |
| GUI login and attach | Remains the sole service/data owner; accepts an authenticated local attachment and current interactive capability set | Attaches, displays `headlessReady` plus interactive capability state | `attached`; desktop-only work is eligible only after capability proof |
| GUI logout or detach | Releases GUI-only capability registration; may continue under the selected persistence policy | Detaches and stops desktop work cleanly | `headlessReady` or `waitingForLogin` |
| Explicit GUI Quit | Uses the existing fenced shutdown and deliberate-stop semantics; startup before login does not override a deliberate Quit | Requests shutdown from the owner, then exits after the fence settles | `stoppedByOwner`, or the existing concrete shutdown refusal |
| Owner Stop | Persists a stop marker before stopping service and releasing the runtime lock | Stop command routes to the owner; GUI does not start a competing service | `stoppedByOwner` remains across reboot until explicit Start |
| Owner Start | Clears the stop marker, validates the configured root, acquires ownership, and starts | GUI reconnects to the owner | `starting`, then current service state |
| Upgrade | Stops admission, drains or fences active work, checkpoints/closes the database, switches to a verified immutable release, then restarts | Reattaches only after service protocol/version check passes | `upgrading`, then `headlessReady`; failure rolls back and reports `upgradeFailed` |

One exclusive lock must cover the runtime database and dispatch ownership.  On lock contention, the second process must exit with a readable `ownerAlreadyRunning` status; it must not bind the service port, migrate schema, or start jobs.  The GUI attaches to the running owner instead of owning a second database connection with write authority.

## Stop Marker, Persistence, And Upgrade

Use the existing stop-marker semantics as the product model, but put the marker and exclusive lock in the selected service data root.  Window close follows the existing persistence policy; an explicit Quit or Stop retains the existing fenced shutdown and persists the stop marker.  Startup before login is a boot policy, not permission to override a deliberate stop.  Reboot must not clear a deliberate Stop.  Explicit Start or an owner-confirmed startup-policy change clears it.

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

## Owner Decision Needed

Should the first pre-login implementation use **same-user service identity with credentials blocked until that user’s login Keychain is available** (recommended), or a **dedicated service identity with an explicitly designed data migration and service-accessible credential mechanism**?  The second option changes file ownership and credential architecture; neither option enables automatic login or changes FileVault.
