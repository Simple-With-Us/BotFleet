# BotFleet Control After The Node Harness: Design Review And Decision Draft

Date: Thu, Oct 29, 2026.  Author: the Claude seat, for the P-BF-6 native macOS rewrite.  Issues: BF-2528 (Control admin surface) and BF-2531 (refreshed Control install), with BF-2527, BF-2537, BF-2514, BF-2515, BF-2544 and BF-2510 as inputs.  Tree audited: `origin/main` at `57ef01510`, read only, nothing built or run.  Every claim below cites a path in that tree; a claim about the owner's Mac is marked as not checked, because this review was written on the Hetzner server.

## Summary

BF-2528 asked for one menu bar surface that shows the harness, the companion sidecar and the MCP server together, with start, stop and status for each, where a stop survives the five-minute launchd tick and the next reboot.  Three pull requests that merged after the issue was filed (#1350, #1383 and #1387) built most of that: a `Fleet Services (12)` submenu with Start, Stop and Restart rows for all three processes and nine other fleet jobs, immediate starts through `launchctl kickstart` and `pm2 start`, a `Start Server At Login` toggle on the `BF_CONTROL_STARTUP_POLICY_V1` markers, and a reconciler that keeps the MCP server in step with the harness.

Four gaps remain, and all four were confirmed by an adversarial second pass over the source.  Only the harness has a durable stop; the companion's stop is a bare `launchctl bootout` that the next login undoes, and the MCP server's stop lives in the Control app's memory and is forgotten on relaunch.  A harness that is running but older than Control reads as `unresponsive`, with every action disabled, which is the Oct 21 outage in BF-2527.  The companion row is presence only, with no health probe of port 8810.  And nothing in the repository addresses the `AutoLoginUser` blocker, which means no per-user LaunchAgent starts after an unattended reboot whatever Control does.

The larger finding is structural.  Every local capability of Control depends on the Node harness that Phase 6 retires: the six HTTP routes it calls live only in `server/index.ts`, it supervises the `app.botfleet.server` and `app.botfleet.companion` LaunchAgents and the `pm2 botfleet-mcp` job that BF-2514 and BF-2515 remove, its offline VM helper is compiled from `server/local-vm-offline-cli.ts`, and its only build, test and install path is the Electron packaging pipeline that the decommission runbook deletes in Step 6.  The rewrite documents say Control is kept (`docs/native-rewrite-port-inventory.md:129`, `docs/native-rewrite-decommission-runbook.md:183`) and also that its markers are retired at BF-2514 (`docs/native-rewrite-port-inventory.md:156`), and neither `scripts/check-decommission-gates.mjs` nor `scripts/audit-node-decommission.mjs` mentions `mac-control/` at all.  Nothing stops BF-2514 and BF-2515 from landing with Control broken.  The native app cannot take over yet: today it is a pure client of port 8799, it cannot start the harness, its menubar has no lifecycle rows, and its shutdown route has no in-flight-work fence.

Three decisions belong to Jay and are drafted below.  The code I will build now is the part that holds under every answer: durable stops for the companion and the MCP server, an honest `too old` state for the harness with a stop that still works, a health probe for the companion row, and the version stamp fix for the Control bundle.

## What BF-2528 Asked For, And What Main Already Has

| Ask | State on main | Evidence |
|---|---|---|
| Harness status in the menu | Done | `ControlAPI.swift:119-167`, `main.swift:475-490`, `ManagedServices.swift:107-117` |
| Companion status in the menu | Partial: `launchctl list` presence only, no port 8810 probe, no `failed` state | `FleetServices.swift:63-67`, `StartupPolicy.swift:202-213` |
| MCP server status in the menu | Done: `GET 127.0.0.1:8794/health` with identity check | `McpServerControl.swift:261-314` |
| Start and Stop for all three | Present, with gating: no MCP Start while the harness is off; harness `unknown` offers Restart only; top-level Stop needs a status answer | `FleetServices.swift:342-368`, `main.swift:529-530` |
| Stop survives the launchd tick and reboot | Harness yes, through `stopped.marker` written by the server route and honoured by the wrapper.  Companion no.  MCP no. | `server/harness-lifecycle.ts:100`, `scripts/botfleet-server-start.sh:164`, `StartupPolicy.swift:326-335`, `FleetServices.swift:97-131` |
| Start takes effect immediately | Done: `launchctl enable`, bootstrap if needed, `kickstart`; `pm2 start` with ecosystem fallback | `StartupPolicy.swift:229-243`, `McpServerControl.swift:186-198` |
| Per-boot `enabled at login` flag | Done for the harness only | `main.swift:698-700`, `StartupPolicy.swift:215-227` |
| One surface for all three | Done: `Fleet Services (12)` | `main.swift:511-526`, `FleetServices.swift:70-83` |
| BF-2527: `running but too old` distinct from `offline` | Missing | `ControlAPI.swift:203-210`, `main.swift:166-189` |
| Wheelhouse header and companion row (OpenCode, Oct 22) | Done: no `Wheelhouse` string remains (#1328, #1383); companion is row 3 | `FleetServices.swift:70-73` |
| `AutoLoginUser` blocker | Unaddressed anywhere in the tree | repo-wide search, zero hits |

## The Proven Gaps

### Companion Stop Does Not Stick

Control's companion stop is `launchctl bootout gui/<uid>/app.botfleet.companion` and nothing else (`StartupPolicy.swift:326-335`).  Booting out holds for the current login, because an unloaded job has no `StartInterval` to fire, but the plist carries `RunAtLoad true` (`scripts/launchd/app.botfleet.companion.plist:57`) and Control never issues `launchctl disable`, so the sidecar returns at the next login.  The wrapper `scripts/botfleet-companion-start.sh` reads no marker at all, and its `--stop` flag logs and exits 0 while its usage text promises to remove the published runtime claim (`:56-59` versus `:82-85`).  BF-2537 already records the live symptom: `launchctl print-disabled gui/501` listed the companion as enabled while the Mac process register said parked.

The fix that needs no shell change is to make Control's Stop issue `launchctl disable` before the bootout, since Start already issues `launchctl enable` (`StartupPolicy.swift:313-315`).  The launchd disabled map persists across logins and reboots, which is exactly the durability BF-2528 asked for, and it is the same one-line remedy BF-2537 proposed by hand.

### MCP Stop Lives In Memory

An owner's Stop on a pm2 row is remembered only in `OwnerStops`, an in-process set (`FleetServices.swift:97-131`, `main.swift:49`).  The README says so: a relaunch hands the fleet back to its own rules (`mac-control/README.md:25`).  Because the reconciler wants the MCP server running whenever the harness runs (`FleetServices.swift:49-53`, `main.swift:264-292`), a Control relaunch or a login restarts the MCP server the owner deliberately stopped.  Whether pm2's own dump restores it at boot cannot be read from the repository, because `~/apps/pm2-ecosystem.config.cjs` is not tracked.

The fix is to persist the owner-stop record to a 0600 file under `~/.botfleet` and read it at launch, so the memory outlives the app.

### A Too-Old Harness Reads As Unresponsive

`ControlAPI.send` maps every non-2xx response except 409 to `.refused` (`ControlAPI.swift:203-210`), and `status()` rewrites only `.unavailable` (`:124-130`).  A harness that answers `/api/health` but has no `/api/system/control` route therefore yields `.refused`, the menu shows `Server: unresponsive` plus an `Error:` line with the server's 404 text, `Start Server` is disabled because the API did not read as unavailable, and `Stop Server And Local VMs…` is disabled because there is no status (`main.swift:529-530`).  That is BF-2527 as Jay saw it on Oct 20: a running server that Control could neither read nor stop, with a clickable Start that did nothing.

Nothing in Control compares versions.  The harness does carry one (`server/runtime-identity.ts:8-11`), but it is served only behind the owner nonce on `/api/runtime` or on the loopback-only `/api/update/status`, and Control calls neither; `/api/system/control` itself carries no version field (`server/index.ts:15028-15038`).  Control never reads its own bundle version either.

The fix is a distinct `routeMissing` error for a 404 on the control route, a `Server: running, but older than Control` status line that names the remedy, and a stop path that still works: write `stopped.marker` and boot the job out, after a confirmation that says the in-flight-work check is unavailable on this server.  A version handshake is the longer fix and belongs with BF-2531 below.

### The Companion Row Is Presence Only

The companion row reads `running` whenever `launchctl list` shows a PID, whether or not anything serves port 8810 (`StartupPolicy.swift:202-213`); no code in `mac-control` mentions 8810 or 8811.  The MCP row already does this properly with an HTTP identity probe.  The companion wrapper's own health check is `curl 127.0.0.1:8810/api/health` (`scripts/botfleet-companion-start.sh:63-66`), so the same probe in Control gives the row a real state.

### Nothing Starts After An Unattended Reboot

Both jobs are per-user LaunchAgents in `gui/<uid>`, Control's own login item is `SMAppService.mainApp`, and no code or document in the tree mentions `AutoLoginUser`, automatic login or a LaunchDaemon for BotFleet.  BF-2528 reported that `AutoLoginUser` is unset on the Mac; this review did not check the Mac.  This is Decision 3.

### The Register Conflict

BF-2528 reports that `MAC-LOCAL-PROCESSES.md` row 210 records an `Owner Requested Off (Oct 20)` policy applied to the older `com.jay.botfleet-server.plist.disabled` label while `app.botfleet.server` stayed loaded.  That file lives on the Mac, outside this repository, and was not checked from here.  A Mac seat should reconcile it in the same change that settles Decision 1.

## The Bigger Finding: Control's Local Half Is Node

Control calls six routes on `127.0.0.1:8799`: `GET /api/health`, `GET /api/system/control`, `PATCH /api/config`, and `POST /api/system/control/stop`, `vms/start` and `vms/stop` (`ControlAPI.swift:123-160`).  All six are implemented only in `server/index.ts` (`:834`, `:14977-15104`, `:18640`).  No Swift code serves them; the unwired `NativeCompanionServer` answers `/api/health` with a shape that Control's identity check would reject as a foreign service (`NativeCompanionServer.swift:656-662` against `ControlAPI.swift:159-167`).

Beyond HTTP, Control depends on the `app.botfleet.server` LaunchAgent and `~/apps/botfleet-server-start.sh` (its policy gate is a substring test for `BF_CONTROL_STARTUP_POLICY_V1` in that file, `StartupPolicy.swift:178-182`), on the `app.botfleet.companion` LaunchAgent, on `pm2 botfleet-mcp` serving `scripts/mcp-sse.ts`, and on a bundled helper compiled from `server/local-vm-offline-cli.ts` (`electron/build-control-app.mjs:27-30`).  The decommission runbook deletes the server launcher and plist in Step 5 (`:145`), the companion plist at BF-2514 (`docs/native-rewrite-port-inventory.md:121`), and the MCP SSE bridge as a dev-only surface with no production caller (`runbook:114-118`).  Control, by contrast, lists the MCP server first and calls it the service the fleet is judged by (`FleetServices.swift:42-43`, `README.md:19`).  One of those two views is wrong, and the review could not settle it from the repository.

Control is built only by `electron/build-control-app.mjs`, which every `package:mac*` script runs (`package.json:78-82`), shipped only as an Electron `extraResources` entry (`electron-builder.yml:143-144`), installed only by `electron/server-controls.mjs` on an explicit `Server Controls…` click, and tested only inside the Electron Mac packaging gate.  The native release workflow builds scheme `BotFleetMac` alone and never mentions Control.  Runbook Step 6 deletes `electron/`, `electron-builder.yml` and the Mac packaging workflows.  After that step there is no way to build, sign, ship or install Control.

The native app is not ready to absorb any of this.  `MacSession` connects to `127.0.0.1:8799` through `CompanionClient` and has no local-engine mode (`MacSession.swift:531-569`); the Phase 4 engine runners, `DatabaseService`, the Zulip actor and the routines scheduler exist as tested libraries that nothing in `ios/MacApp` instantiates.  The app cannot start the harness; it clears `stopped.marker` on a deliberate launch and waits for the five-minute tick (`MacSession.swift:575-581`, `707-716`).  Its menubar has twelve rows and none is a server, VM, service or startup control (`MacSystemIntegration.swift:304-322`).  Its `Shut Down Server & Local VM` calls `POST /api/system/shutdown`, which writes the marker and exits the process after 250 ms with no in-flight-work fence (`server/index.ts:14954-14976`), while Control's stop uses the fenced `/api/system/control/stop` that refuses while work is active.  Both apps also write `persist-on-exit.policy` and `stopped.marker` through two separate implementations of one wire contract, and `stopped.marker` now has four writers with three body formats and an existence-only reader.

Control also holds the only remote-server UI in the product today: `Connected Servers` with Bearer tokens in a 0600 `control-hosts.json`, per-host stop and VM actions, and remote VM providers (`ServerHost.swift`, `VMProvider.swift`).  The native app has a single free-text host and port with no saved hosts and no token (`BotFleetMacApp.swift:162-173`).  Under BF-2544, where the server is optional and remote, that logic is product, not fleet operations, and it has to live where the user is.

## Decision 1 For Jay: What Is BotFleet Control After Node?

Option A, retire and absorb.  The native app grows a lifecycle section in its menubar and Settings: harness status with bot count and blocking work, fenced start and stop, `Start Server At Login`, the shared VM, and the saved servers list from Control.  Control is deleted with Electron in Step 6.  The nine non-BotFleet pm2 rows and the process and port monitor are dropped from the product.

Option B, keep Control as a separate tool.  The native app must then serve a Control-compatible control channel (`/api/health` with the identity shape, `/api/system/control` and its stop and VM routes, `PATCH /api/config`), Control needs a build and install path outside Electron (a `swift build` job in `native-mac-release.yml` or its own workflow, with Developer ID signing), the decommission gate and audit must list `mac-control/` as retained with a named owner, and the policy gate must stop reading a deleted shell wrapper.

Option C, split by audience.  Everything a BotFleet user needs moves into the native app as in Option A: harness lifecycle, startup policy, login item, VM, and saved servers for the optional server mode.  Everything that is Jay's Mac fleet administration moves out of the BotFleet product: the twelve-row fleet services list, the pm2 rows, the process and port monitor with orphan kill, and the remote VM providers.  Muster, the fleet admin Mac app under AFC-354, already exists for that audience and is Swift; a standalone SwiftPM tool with its own small workflow is the fallback if Muster does not take it.

Recommendation: Option C.  BF-2544 fixes the default product as a Mac-only install with no server, so the lifecycle surface has to be in the one app a user downloads, and the native app has to own harness start, status and a fenced stop before BF-2514 anyway.  The fleet rows are not BotFleet features, and shipping them in the product would mean shipping Jay's process names.  Whatever the answer, four things are needed before BF-2514 lands: the native app owns harness start, status and a fenced stop; the native app owns the startup policy and a login item; `scripts/check-decommission-gates.mjs` and `scripts/audit-node-decommission.mjs` name `mac-control/` with its disposition; and a BF issue carries each piece, because today no issue in P-BF-6 does.

## Decision 2 For Jay: BF-2531, Install Or Refuse

What is true today.  The Electron app does install a refreshed Control bundle, but only when the owner clicks `Server Controls…` and only when Control is not running (`electron/server-controls.mjs:50-80`); Control is a login item, so the running case is the normal one and a stale copy survives indefinitely.  `~/apps/update-botfleet.sh` and `scripts/update-botfleet-mac.mjs` never touch Control.  Control's version is `git rev-list --count HEAD` of whichever checkout built it, with no floor and no shallow-clone guard (`electron/build-control-app.mjs:71-82`), while the app uses `scripts/stamp-commit-version.mjs`, which has both.  The release workflow's Mac job checks out at the default depth, so a release-built Control may be stamped `1.0.1`; this is inferred from `release.yml:116-119` and not confirmed from an artifact.  Control has no version handshake with the harness, so skew is invisible until a route is missing.

Option 1, install on update.  After the app updates, compare the bundled Control's `build-identity.json` with the installed copy, quit and replace the installed bundle, and relaunch it.  This installs an application into `~/Applications` without a click, which is why BF-2531 asked for a ruling.

Option 2, handshake and refuse with an explanation.  Control reads the harness's `sourceCommit` from the loopback `/api/update/status` route, or a new version field on `/api/system/control`, compares it with its own bundle identity, and shows `Control is older than the server` or `newer than the server` with an `Update Control` action that performs the Option 1 replacement only on that click.  No install happens without consent, and the greyed-out menu of Oct 21 can never recur silently.

Option 3, one bundle.  If Decision 1 picks A or C, the lifecycle surface ships inside `BotFleet.app` and there is no second bundle to skew.  The fleet-ops remainder, wherever it lands, keeps a handshake because it still talks to a server it does not ship with.

Recommendation: Option 2 now, under either answer to Decision 1, plus the version stamp fix so Control and the app carry the same number from the same stamp.  Option 1 only with Jay's explicit yes, because it is an unattended install.  Option 3 follows Decision 1.

## Decision 3 For Jay: Starting After An Unattended Reboot

BF-2528 reports `AutoLoginUser` unset, so nothing in `~/Library/LaunchAgents` loads until someone logs in.  There are three honest answers.  Enable automatic login for the owner account, which gives launchd a GUI session at boot; with FileVault on, the disk still waits for a password at the pre-boot screen, so this only helps a restart that reaches the login window.  Move the harness to a LaunchDaemon, which starts without a login but runs with no window server, so the computer-use agent, screen capture, Accessibility and every TCC-gated feature stop working until a user session exists; the harness drives the desktop, so this does not fit.  Or accept that the stack starts at first login, write that down in the register and the Apple Note, and have the iOS remote wake show `waiting for login` instead of `offline` when the Mac is up and the harness is not.

Recommendation: accept first-login start as the documented behaviour, and treat automatic login as a separate owner security decision with the FileVault caveat stated.  Not checked from here: the Mac's current `AutoLoginUser` and FileVault state.

## What I Will Build Now

These hold under every answer above and ship in `mac-control/` with tests.

- Durable companion stop: Stop issues `launchctl disable` before `bootout`; Start keeps `enable`, bootstrap and `kickstart`.  Covered by the existing launchctl fakes in `FleetServicesTests`.
- Persistent owner stops: `OwnerStops` is loaded from and written to a 0600 file under the Control data directory, so a deliberate MCP or companion stop survives a Control relaunch and a login.
- Honest too-old state: a 404 on `/api/system/control` becomes `routeMissing`, the status line reads `Server: running, but older than Control`, the error line names the remedy, and `Stop Server And Local VMs…` stays enabled through a marker-and-bootout fallback whose confirmation says the in-flight-work check is unavailable on this server.
- Companion health: the companion row probes `127.0.0.1:8810/api/health` and reports `failed` when the job is loaded but not serving.
- Version stamp: `electron/build-control-app.mjs` stamps the bundle through `scripts/stamp-commit-version.mjs`, so Control and the app share a number and a shallow checkout refuses to build.

Not in this slice: the version handshake and `Update Control` action (Decision 2), any change to the companion wrapper or pm2 configuration on the Mac, any launchd or plist change on a live machine, and anything that depends on Decision 1.

## Open Items And Owners

- BF-2537: the live `launchctl disable` for the companion is Jay's call; once this slice ships, Control's Stop performs it on request.
- `MAC-LOCAL-PROCESSES.md` row 210: a Mac seat reconciles the register with the loaded label.
- `pm2` resurrect at boot: not readable from the repository; a Mac seat should check `pm2 startup` state.
- Hand-run detection: the wrapper treats any non-empty `XPC_SERVICE_NAME` as a launchd tick (`scripts/botfleet-server-start.sh:120`); whether a Terminal shell on macOS carries one needs a check on the Mac.
- BF-2510: the companion endpoint ruling is still unrecorded in Linear and the tree; it decides whether a companion row exists at all after Node.
- The MCP server's production callers: the runbook says none, Control says primary; whoever owns the pm2 ecosystem file settles it.
