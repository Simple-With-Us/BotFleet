# iOS Companion Topology Under Server-Based Placement

Status: source-verified topology record (`Refs BF-2652`), checked against `origin/main` commit `804ecc9be1f66142752729ed3cb25f094966af6d`.  This document is not live verification: no iPhone pairing, hosted HTTPS probe, Tailscale failover, foreground SSE cursor replay, or APNs delivery was executed against any Mac, server, or device.

## Outcome And Boundary

`BF-2652` asks how the iOS companion stays consistent when BotFleet runs in a server-based placement mode without inventing an unnecessary sync protocol or authorizing premature server exposure.  This record distinguishes what the codebase currently ships, what `BF-2510` and Option C already ruled for native macOS, where server-owned state diverges from Mac-local companion state today, and which open choices require Jay before live `BF-2652` acceptance runs proceed.

## Placement Modes And State Ownership

`shared/placement.ts:7` defines `PlacementMode = "localOnly" | "serverFirst" | "macFirst"`.  Per `docs/plans/2026-10-29-native-server-mode.md:31-58, 64, 74, 82-84, 96-100`, authoritative job-state ownership and companion reachability differ across the three modes as follows:

| Mode | Controller Host | Worker Host | Authoritative Job Records | Companion Impact Under Option C (Phone Pairs With Mac) |
| --- | --- | --- | --- | --- |
| `localOnly` | Mac (`127.0.0.1:8799` / native runtime) | Mac (same host; no separate worker) | Mac only (`docs/ios-companion.md:4`) | Local state matches Mac companion responses 1:1. |
| `macFirst` | Mac | Linux server (optional overflow / remote worker) | Mac owns controller records; Linux worker runs leased jobs and spools reports (`docs/plans/2026-10-29-native-server-mode.md:64, 74`) | Controller records reside on the Mac, though worker output and completions depend on the lease/heartbeat/spool link staying healthy. |
| `serverFirst` | Linux server (`deploy/linux-server/`) | Mac (when `allowOverflowToThisMac` is enabled or job requires `macos` / pin) | Linux server owns controller records (`docs/plans/2026-10-29-native-server-mode.md:64`); Mac worker holds local lease records only while running a leased job | **Gap:** Mac companion state currently reads local Mac state only; unbridged `NativeCompanionServer` or sleeping-Mac setups do not reflect server-owned jobs, approvals, or completions. |

## Shipped Path Versus Option C Ruled Architecture

Three completed Linear issues establish the baseline contract:  `BF-2510` (*Decide the iOS Companion Endpoint After the Node Harness*, state `Done`, completed `2026-10-29T20:36:13Z`), `BF-2511` (*iOS Companion API After Node: Build the Chosen Endpoint*, state `Done`, completed `2026-11-13T18:42:45Z`), and `BF-2591` (*Native companion server speaks the iOS client's pairing contract*, state `Done`, completed `2026-10-30T22:18:38Z`).

### What Currently Ships On Main

- **Node companion sidecar (`docs/ios-companion.md:30-39, 66-104`, `companion/src/index.ts:72-89, 175`, `companion/src/proxy.ts:457-461`, `companion/src/apns.ts:1-3, 2248`):** Port `8810` proxies the local harness (`8799`), serves SSE (`GET /api/events`), enforces pairing/device allowlists, advertises LAN/Tailscale endpoints, and watches local harness notifications (`watchHarnessNotifications`) for APNs alerts.  `docs/ios-companion.md:161` records that hosted HTTPS is **not available in current builds**.
- **Linux server deployment excludes `companion/` (`deploy/linux-server/retained-source.json:14, 1326, 1483-1490, 1678-1687`, `deploy/linux-server/botfleet-server.service.in:1-64`):** The server deploy manifest retains `server/placement-*.ts`, `shared/placement*.ts`, `server/companion-writes.ts`, and `deploy/linux-server/owner-gate.mjs` on port `8799`, and retains zero `companion/` sidecar files.  No companion `:8810` listener ships in `deploy/linux-server/`.
- **Native `NativeCompanionServer` & `CompanionListenerController` (`ios/Sources/CompanionCore/NativeMacCompanionRuntime.swift:167-169`, `ios/Sources/CompanionCore/NativeCompanionServer.swift:1025-1065, 1250-1364`, `ios/Sources/CompanionCore/CompanionListenerController.swift:34-35`, `docs/rollouts/2026-10-30-native-companion-pairing-contract.md:22`):** `BF-2510` and Option C (`docs/plans/2026-10-29-botfleet-control-after-node.md:87`) ruled that the native Mac app hosts the companion API.  On `origin/main`, `CompanionListenerController` still defaults to `.off` (`"The phone pairs with the Node harness until the native pairing contract lands (BF-2511)."`), and `NativeMacCompanionRuntime.makeServer()` initializes `NativeCompanionServer` without placement settings or a controller client.
- **Pre-login native host remains design-only (`docs/plans/2026-10-30-optional-prelogin-host.md:3, 14-20`):** No headless pre-login native companion service executable or LaunchDaemon ships today; `MacSession.swift` only runs inside an interactive GUI login session.

## Verified Topology Gaps For `serverFirst`

Inspection of `804ecc9be1f66142752729ed3cb25f094966af6d` identifies four concrete source gaps separating current `main` from verified `serverFirst` iOS companion sync:

1. **Controller-to-companion state gap:** In `serverFirst`, the Linux controller owns job records, queues, and approval waits (`docs/plans/2026-10-29-native-server-mode.md:64, 96`).  Neither `companion/` on Mac nor `NativeCompanionServer` (`NativeCompanionServer.swift:1254-1364`, `NativeMacCompanionRuntime.swift:167-169`) currently proxies or merges controller-owned fleet, thread, wait, or SSE streams from a remote Linux controller.
2. **Server sleep / Mac availability gap:** Because `deploy/linux-server/` ships no companion listener and Mac `MacSession.swift` is per-user post-login (`docs/plans/2026-10-30-optional-prelogin-host.md:14`), pairing the phone exclusively to the Mac means a sleeping or logged-out Mac cuts off phone access to server-running jobs unless either a server-side companion route exists or the phone pairs directly over an approved route.
3. **APNs delivery source gap:** `companion/src/apns.ts:2248` (`watchHarnessNotifications`, wired at `companion/src/index.ts:175`) monitors a single local harness.  `NativeCompanionServer.swift:1332-1364` stores push tokens and checks `apnsProvider` locally.  When the Linux controller completes a job or hits an approval wait while the Mac listener is asleep, nothing on the Linux server currently dispatches APNs notifications to phone tokens registered only on the Mac.
4. **Published HTTPS & route policy gap:** `ios/Sources/CompanionCore/Client.swift:27-40` already models `endpoints`, `allowedRouteKinds`, and `allowedLocalRouteURLs` for hosted HTTPS alongside LAN/Tailscale.  However, `docs/ios-companion.md:161` notes hosted HTTPS is not built yet, and `NativeCompanionServer.handleCompanionEndpoints` (`NativeCompanionServer.swift:1254-1263`) only echoes app-injected `endpointAdvertisement` (empty by default per `docs/rollouts/2026-10-30-native-companion-pairing-contract.md:12`).

## Open Questions For Jay Before Live Implementation Or Exposure

Per `BF-2652` boundaries, answering these requires an owner decision (consistent with open question 11 in `docs/plans/2026-10-29-native-server-mode.md:207`):

1. **Server-first phone data path:** In `serverFirst`, should the native Mac app (`NativeCompanionServer`) proxy controller-owned threads, waits, `/api/events`, and approvals from the configured Linux server so the phone keeps one Mac pairing under `BF-2510` Option C, OR should the Linux server expose a restricted companion/bridge route directly so the phone stays connected when the Mac is asleep?
2. **Background APNs ownership in `serverFirst`:** Should APNs background notifications originate exclusively from the Mac (accepting paused push when the Mac sleeps under Option C), or should the Linux server hold a scoped APNs sender (`AUTHKEY_*`) fed by controller job/wait events and phone push registrations?
3. **First live HTTPS / Tailscale verification target:** Should initial `BF-2652` end-to-end verification target Tailscale HTTP between iPhone and Mac/server once the controller bridge is wired, or should hosted HTTPS (`Client.swift` `allowedRouteKinds`) be provisioned and tested first?

## Disposition Of Remaining `BF-2652` Acceptance Items

All remaining live checks in `BF-2652` cannot be completed from an isolated Linux documentation lane and map cleanly to `owner_gated` or `mac_only` gates:

| `BF-2652` Acceptance Item | Disposition | Preconditions Required Before Claiming Pass |
| --- | --- | --- |
| 1. Intended serving topology and state ownership | **Recorded here (`Refs BF-2652`) + `owner_gated`** | Jay's answers to Open Questions 1 and 2 decide Mac-proxy vs server-route and APNs locus for `serverFirst`. |
| 2. Published HTTPS route, consent, discovery, pairing, revocation | **`owner_gated` + `mac_only`** | Owner approval for any server exposure/TLS route plus physical Mac + iPhone/iOS simulator pairing run. |
| 3. Hydration, approvals, foreground SSE cursor replay vs server-owned state | **`mac_only` (blocked on `serverFirst` bridge + Mac/iOS test run)** | Implement chosen controller-to-companion bridge and verify on Mac + iOS (`xcode-27` / device) against an isolated test server. |
| 4. APNs background alerts vs foreground SSE on same deployment | **`owner_gated` + `mac_only`** | Owner APNs decision (Open Question 2), scoped Infisical APNs key access, and physical iPhone background receipt. |
| 5. Supported live verification recipe & deployment evidence | **`mac_only` + `owner_gated`** | End-to-end run against the chosen deployment with attached timestamps and logs; local fixtures never substitute for live verification. |
