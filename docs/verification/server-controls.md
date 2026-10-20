# Independent Server Controls

BotFleet Control is a native macOS menu bar app that can stay running after BotFleet quits.  It reads server and Local VM state only while its menu is open, and never starts the server simply because the controller opens.  Closing the last BotFleet window now quits Electron instead of hiding it in the menu bar; the existing persistence preference determines the attached server lifetime.

## Fixture Verification

Run from a seat lane:

```sh
pnpm typecheck
pnpm test
pnpm exec vitest run server/system-control.test.ts server/harness-lifecycle.test.ts
pnpm test:control
pnpm build:control
git diff --check
```

The Swift tests inject HTTP responses, filesystem roots and command runners.  The server tests inject VM status, leases and actions, and the wrapper tests use a temporary root, fake boot identity and a stub runtime.  They do not contact port 8799, start a real server, or mutate a container runtime.

The build runs Swift tests, builds both arm64 and x86_64 slices, checks the generated plist and verifies the app signature.  The existing Mac packaging gate runs for changes under `mac-control/` and packages the controller alongside the main app.

## Install And Open

```sh
pnpm install:control
open "$HOME/Applications/BotFleet Control.app"
```

Opening **Server Controls…** from BotFleet's File or tray menu installs the packaged controller into the same location.  A running copy is preserved until it quits, and an unrelated bundle or symlink is refused.

The controller has no Dock icon.  **Hide Menu Bar Icon** leaves it running; reopen its app to restore the icon.  **Quit Control** quits only the controller.

## Lifecycle Boundaries

**Keep Server Running After Quitting BotFleet** writes the existing server setting through its normal configuration API and Infisical policy.  It requires a running, compatible server.

**Start Server At Login** is a local operating-system startup preference.  The tracked wrapper honors `startup-enabled.marker`, `startup-disabled.marker` and a `startup-session` boot identity in the BotFleet data directory.  Disabling login startup preserves crash recovery for a server deliberately started during the current boot.  The next boot receives a different identity and stays down until an explicit launch.  Explicit enablement allows launchd to clear a stop from a previous boot; a stop during the current boot remains in force.  Turning the preference on does not start a server immediately.  With neither policy marker, the original durable-stop behavior remains.

The controller refuses startup changes when the installed wrapper lacks the V1 policy capability.  Upgrading the app alone does not install the tracked wrapper; operators must review and update the existing `~/apps/botfleet-server-start.sh` separately.

**Launch Control At Login** uses macOS Login Items and controls the native controller independently.

Server and VM stop actions refuse active bots, leases and conflicting setup actions.  They address BotFleet's shared and per-bot Local VMs, never the machine-wide Docker or OrbStack daemon.  Stopped containers cannot safely resume under the existing desktop image contract; the controller preserves their disks and directs the owner to Computer settings for recreation instead of deleting them silently.

The server must expose the new control routes.  An older or unavailable server produces an explicit error or unknown status rather than a successful shutdown claim.  Pairing or a companion replay does not grant access to these local controller routes.
