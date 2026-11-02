# Independent Server Controls

BotFleet Control is a native macOS menu bar app that can stay running after BotFleet quits.  It reads server and Local VM state only while its menu is open, and never starts the server simply because the controller opens.  Closing the last BotFleet window now quits Electron instead of hiding it in the menu bar; the existing persistence preference determines the attached server lifetime.

## Fixture Verification

Run from a seat lane:

```sh
pnpm typecheck
pnpm test
pnpm exec vitest run server/system-control.test.ts server/harness-lifecycle.test.ts
pnpm exec vitest run server/graceful-shutdown.test.ts server/graceful-shutdown-route.test.ts server/desktop-open-policy.test.ts
pnpm exec vitest run server/graceful-shutdown-e2e.test.ts
pnpm exec vitest run server/local-vm-offline.test.ts server/container-computer.test.ts server/config.test.ts
pnpm test:control
node electron/build-control-app.mjs --helper-only
node 'electron/resources/BotFleet Control.app/Contents/Resources/botfleet-vm-control.mjs' invalid
pnpm build:control
git diff --check
```

The Swift tests inject HTTP responses, filesystem roots and command runners.  The server tests inject VM status, leases and actions, and the wrapper tests use a temporary root, fake boot identity and a stub runtime.  They do not contact port 8799, start a real server, or mutate a container runtime.  The helper-only build and invalid-action probe verify that the standalone bundle loads and emits strict JSON without calling Docker.

The graceful stop's fixture injects the clock, the wait, the bot roster, the in-flight count and the work breakdown, so the window, the classification of a finished bot against an interrupted one, the refusal when the queued work cannot be saved and the report's wording are all exercised without a server, a store or a filesystem.

`server/graceful-shutdown-e2e.test.ts` drives the route itself:  it boots one real harness on a throwaway home with a provider fixture that holds its answer open, waits until the bot's turn is in flight, and then asks the server to stop.  It reads the time from the harness's own log, so it measures the stop rather than the request, and it asserts that the stop ends well inside the ten second window and that the report does not name the stop's own control lock as work left running.  The same fixture on the pre-fix head took 10,008 ms and reported "still running: 1 Local VM change";  on the fixed tree it takes about 2,076 ms.

The second scenario in that file is the refusal path:  it puts a directory where the carrier file belongs, so the write that carries the queued messages across the restart fails, and it asks the server to stop anyway.  The stop has to refuse, the server has to stay up and keep serving, and the message that was waiting behind the bot has to run afterwards, which the provider's request count proves:  twice with the work put back, once without it.  With the restore removed the fixture fails on that count, which is how the loss was proven rather than assumed.

The build runs Swift tests, builds both arm64 and x86_64 slices, checks the generated plist and verifies the app signature.  The existing Mac packaging gate runs for changes under `mac-control/` and packages the controller alongside the main app.

## Install And Open

```sh
pnpm install:control
open "$HOME/Applications/BotFleet Control.app"
```

Opening **Server Controls…** from BotFleet's File or tray menu installs the packaged controller into the same location.  A running copy is preserved until it quits, and an unrelated bundle or symlink is refused.

The controller has no Dock icon.  **Hide Menu Bar Icon** leaves it running; reopen its app to restore the icon.  **Quit Control** quits only the controller.

## Lifecycle Boundaries

**Keep Server Running After Quitting BotFleet** writes the existing setting through the configuration API while the server is running.  The native controller can change the same effective policy while the server is deliberately off using an atomic `persist-on-exit.policy` file under the BotFleet data directory.  Both the server and Electron honor it; online changes update it too.  The file contains only `true` or `false` followed by a newline, with owner-only permissions.

**Start Server At Login** is a local operating-system startup preference.  The tracked wrapper honors `startup-enabled.marker`, `startup-disabled.marker` and a `startup-session` boot identity in the BotFleet data directory.  Disabling login startup preserves crash recovery for a server deliberately started during the current boot.  The next boot receives a different identity and stays down until an explicit launch.  Explicit enablement allows launchd to clear a stop from a previous boot; a stop during the current boot remains in force.  Turning the preference on does not start a server immediately.  With neither policy marker, the original durable-stop behavior remains.

The controller refuses startup changes when the installed wrapper lacks the V1 policy capability.  Upgrading the app alone does not install the tracked wrapper; operators must review and update the existing `~/apps/botfleet-server-start.sh` separately.

**Launch Control At Login** uses macOS Login Items and controls the native controller independently.

Server and VM stop actions refuse active bots, leases and conflicting setup actions.  They address BotFleet's shared and per-bot Local VMs, never the machine-wide Docker or OrbStack daemon.  With the server off, the bundled `botfleet-vm-control.mjs` helper accepts `status`, `create-stopped` or `stop` and emits one JSON result.  It refuses remote Docker contexts, checks the deliberate-stop marker and inactive LaunchAgent before mutation, and filters exact BotFleet labels and names.  `create-stopped` uses the cached managed image and the normal security, workspace and resource contract without a pull, build or start.  A newly created VM may receive its first start after the normal safety checks.  A previously started, stopped container still requires explicit recreation; the controller never deletes its disk silently.

The server's own stop is the exception to the refusal rule.  `POST /api/system/control/stop` stops the bots that are working, keeps the messages queued behind them for the next start, and then shuts the server down through its signal handler, so the event log and the stores get their normal drain.  It still refuses, with 409 and a named reason, for the work a graceful stop cannot carry across the restart, and a room turn in flight is that work.  The reply carries the report of what the stop did, and BotFleet Control shows it.

The server must expose the new control routes.  An older or unavailable server produces an explicit error or unknown status rather than a successful shutdown claim.  Pairing or a companion replay does not grant access to these local controller routes.
