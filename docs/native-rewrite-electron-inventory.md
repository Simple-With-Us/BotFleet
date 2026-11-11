# Electron Main Process Responsibility Inventory (BF-2498)

Every responsibility the Electron main process owns today, and the native
owner that takes it. This is the Electron-side companion to
[`native-rewrite-port-inventory.md`](native-rewrite-port-inventory.md) (BF-2502),
which covers the `server/`, `companion/`, and `shared/` half. BF-2485
(Electron stack decommission) and BF-2514/BF-2515 (harness off, Node
decommission) cite this file as their gate.

Surveyed at commit `ab016dcd8` (2026-11-02) against the `electron/` tree:
72 non-test files (70 `.mjs`/`.cjs`/`.d.mts` plus 2 `*-Info.plist` build
inputs), 34 test files excluded, `electron/vendor/**` excluded.

Owner keys: **BF-xxxx** = an existing issue in the *BotFleet Native macOS
Rewrite* project. **mac-control** = the existing Swift `BotFleet Control.app`,
which already implements part of this. **new issue** = nothing covers it
today; the list in §9 is the file-them list. **retire** = the responsibility
disappears with the Node stack.

## 0. Shape of the problem

`electron/main.mjs` is 3,330 lines and owns roughly 60 `ipcMain` handlers
across 45 named responsibilities. The module boundaries beside it are already
close to the native seams, so the rewrite is mostly a matter of pointing each
responsibility at an owner rather than inventing one.

Three facts shape most rows:

* **The renderer trust boundary disappears.** `electron/preload.cjs` exposes a
  narrow `window.ogb` surface and `electron/renderer-trust.mjs` guards every
  handler by origin. A native shell has no renderer to trust.
* **The harness is the Node child.** Almost every "spawn, probe, adopt,
  supervise" responsibility exists to manage a Node process. When the harness
  is Swift (BF-2514), those rows either collapse into the app's own lifecycle
  or vanish.
* **The iOS companion path is the one deadline.** Nine responsibilities
  (§7) exist only to serve a paired phone, so their fate is settled by the
  BF-2510 endpoint decision, not by preference.

## 1. Harness lifecycle, boot, and identity

| Responsibility | Today | Native owner |
|---|---|---|
| Fork/spawn the harness child; port ladder 8799/18799/28799; env assembly (`OMB_PORT`, `OMB_STATIC_DIR`, `OMB_USER_DATA`) | `main.mjs:1103-1176` | **BF-2497** |
| Attach-or-spawn: `/api/health` probe, PID identity match, foreign-owner detection, build-identity compatibility | `main.mjs:1223-1289`, `server-boot-probe.mjs`, `runtime-identity.mjs` | **BF-2497** |
| Boot budget (60 s), error page for port conflict / foreign owner / slow start, `botfleet://retry-server` | `main.mjs:1103-1289`, `:1850-1863` | **BF-2497** |
| Resolve which server this launch talks to: Infisical vault read via the Keychain bootstrap (`local` vs `remote` + origin/token); the legacy file only earns a delete-me warning | `server-target.mjs`, `main.mjs:1291-1362` | **BF-2497** (consumes the target) + **BF-2506** (vault/Keychain) |
| Headless-harness UI shim: serve bundled UI, stream `/api` (incl. SSE) to an attached harness | `attached-ui-shim.mjs`, `main.mjs:1260-1277` | **retire** (BF-2485) — nothing native reproduces a static-file + SSE proxy |
| Data-root ownership record (`harness-owner.json`, HMAC nonce proof) | `harness-ownership.mjs` | **BF-2514** — becomes the native single-writer lock at cutover |
| Quit semantics: kill the child we spawned, or `POST /api/system/control/stop` on an attached one unless persist-on-exit says keep | `main.mjs:3232-3239`, `:3281-3330`, `server-controls.mjs:9-28` | **BF-2497** (quit policy); BF-2489 already did the server half |
| Read `persist-on-exit.policy` (offline file first, then `config.json`) | `persist-on-exit-policy.mjs`, `main.mjs:3206-3216` | **mac-control** already writes it; **BF-2497** consumes it |
| Record the explicit startup session (`kern.bootsessionuuid`), clear `~/.botfleet/stopped.marker` at launch | `main.mjs:3254-3279`, `:2903-2906` | **mac-control** (`StartupPolicy.swift`) + **BF-2497** |
| Replay the desktop's encrypted credentials into an attached harness, retry every 15 s | `main.mjs:1181-1221` | **BF-2506** |
| Server stdout/stderr to `~/Library/Logs/BotFleet/server.log`; packaged log tail | `main.mjs:729-775`, `:1044-1094` | **retire** (BF-2485/BF-2515) — a native app logs to `os_log` |
| Single-instance lock so a second launch cannot fork a second harness | `main.mjs:345-351`, `single-instance.mjs` | **BF-2497** |
| "Server Controls…" launcher: verify bundle identity, install into `~/Applications`, open | `server-controls.mjs:30-90`, `main.mjs:2790-2798` | **mac-control** (already ships it); the Electron row is **retire** (BF-2485) |

## 2. Companion sidecar and managed tunnel

Every row in this section is conditional on the BF-2510 decision (native app
serves the contract, or a slim Node companion host survives).

| Responsibility | Today | Native owner |
|---|---|---|
| Fork/adopt the sidecar; control port 8811, device port 8810; serialized lifecycle | `companion.mjs:193-370` | **BF-2510** → **BF-2514** |
| Sidecar entry-point ladder (packaged resource → built `dist-companion` output → TS source with `--experimental-strip-types`); null when nothing runnable exists | `companion-entry.mjs`, `companion.mjs:40-55` | **BF-2510** → **BF-2514** |
| Remembered on/off toggle and keep-awake in `userData/companion-settings.json` | `companion.mjs:66-114` | **BF-2497** |
| `powerSaveBlocker` while the companion is on and keep-awake is set | `main.mjs:753-763`, `:3304` | **BF-2484** (native `IOPMAssertion`) |
| Private per-launch Unix-socket origin, cleanup, health proof | `companion-origin-gateway.mjs:39-179` | **BF-2510** |
| Loopback guardian gateway on 8812, parent-death pipe, fail-closed forwarding | `companion-origin-gateway.mjs:217-312`, `managed-companion-guardian.mjs` | **BF-2510** — exists only because the sidecar is a separate process |
| Hosted connector lifecycle and health proof | `managed-companion-tunnel.mjs` | **BF-2510** / **BF-2511** |
| Publish the hosted URL only after public health verification | `main.mjs:876-898` | **BF-2510** |
| Adopt a launchd-supervised sidecar via the runtime claim file | `managed-companion-runtime.mjs:202-218`, `companion.mjs:215-235` | **BF-2514** |
| Companion account service (email code sign-in, control-plane calls, install credential, sign-out) | `companion-account-service.mjs`, `control-plane-client.mjs` | **BF-2511** |
| Pairing open/close, device revoke, per-device cloud-desktop grant | `companion.mjs:469-511` | **BF-2510** / **BF-2511** (Keychain-backed pairing service) |
| Ephemeral hosted fallback | `main.mjs:802-822`, `:2344-2355` | **BF-2510** (keep only if a hosted route survives) |
| Strip inherited `OMB_COMPANION_HOSTED_URL` / `OMB_COMPANION_INTERNAL_ORIGIN` from the child env | `companion.mjs:274-282` | **BF-2510** |
| Quit order: connector, then sidecar | `main.mjs:3312-3325` | **BF-2514** |

## 3. Credentials and secrets

| Responsibility | Today | Native owner |
|---|---|---|
| `credentials.bin` in `userData`, safeStorage encrypt/decrypt, 0600, temp+rename | `main.mjs:435-460`, `secure-credentials.mjs` | **BF-2506** |
| Distinguish `empty` / `ok` / `unavailable`; retry a busy keychain (100/200/400/800 ms) | `secure-credentials.mjs:1-59` | **BF-2506** — a security invariant, not a nicety |
| safeStorage designated-requirement migration across a signing or bundle-id change | `secure-credentials.mjs:64-96`, `main.mjs:2907-2930` | **BF-2499** (stable identity) + **BF-2506** |
| Serialized copy-on-write credential state; roll back the file if the live-apply phase fails | `secure-credential-state.mjs:36-92` | **BF-2506** |
| Boot migration of plaintext `config.json` → encrypted store (Composio + workspace keys), strip legacy fields | `main.mjs:497-547`, `workspace-credentials.mjs` | **BF-2506** |
| `credentialStorage: external` markers written into `config.json` and asserted after write | `main.mjs:662-688` | **BF-2506** |
| Cross-process single-writer lock on `~/.botfleet/config.json` | `config-file-lock.mjs` | **retire** (BF-2514) + **BF-2506** — the lock exists only because two processes write the file |
| `credential:set` / `set-instance` / `clear-instance` → `PUT /api/config?secretStorage=external`, `PATCH /api/instances/:id` | `main.mjs:2498-2625` | **BF-2506** (storage) + **BF-2504** (live instance reload) |
| Refuse credential writes while in remote mode (the key belongs on the remote server, never in this Mac's store) | `remote-credential-guard.mjs`, `main.mjs:2498-2595` | **BF-2506** |
| Restore plan (restore is hydration, never a settings edit) plus instance keys | `credential-restore.mjs` | **BF-2506** |
| Update-credential preparation receipt (`--prepare-update-credentials=`) with a durable marker list | `update-credential-preparation.mjs`, `main.mjs:2931-2950` | **BF-2486** (pipeline) + **BF-2506** (receipt contents) |
| Managed Composio broker registration and credential sync to the harness child | `managed-composio.mjs`, `main.mjs:1534-1545`, `:3137-3157` | **BF-2506** (or retire) |
| Mint short-lived xAI / Gemini realtime tokens; the permanent key never reaches the renderer | `sts-tokens.mjs`, `assemblyai.mjs` | **BF-2506** |
| Data directory resolution (`~/.botfleet` or `OMB_DATA_DIR`) | `app-paths.mjs` | **BF-2506** — one resolver for app and harness |
| Read-only Infisical vault client (service-token shape check, one raw-secrets request, unresolved-reference refusal; no env fallback, never logs a value) | `infisical-read.mjs` (consumed by `server-target.mjs`, Linux `owner-gate.mjs`) | **BF-2506** |

## 4. Updater

| Responsibility | Today | Native owner |
|---|---|---|
| Check / download / install, GitHub provider, `app-update.yml` | `updater.mjs:253-307`, `updater-coordinator.mjs` | **BF-2486** (Sparkle) |
| 6-hour auto-check throttle, 3-strike backoff to 24 h, bundle-fingerprint bypass | `updater-throttle.mjs:1-40` | **BF-2486** — reimplement deliberately, not inherited |
| Persist `lastCheckMs` into the harness `config.json` under the config lock | `updater-throttle.mjs`, `updater.mjs:106-124` | **BF-2486** + **BF-2506** (it is a tunable knob, so it belongs in the knob table) |
| Local update: spawn `~/apps/update-botfleet.sh` detached with the owner nonce | `updater.mjs:151-250` | **retire** (BF-2515) or **BF-2486** |
| Broadcast updater state to the renderer | `updater.mjs:90-97`, `:126-151` | **BF-2486** |
| Updater log at `~/Library/Logs/BotFleet/updater.log` | `updater.mjs:73-88` | **BF-2486** (`os_log`) |

## 5. CUA and screen capture

| Responsibility | Today | Native owner |
|---|---|---|
| Resolve the `cua-driver` binary (bundled → `/Applications/CuaDriver.app`) | `cua.mjs:115-123` | **BF-2509** |
| Embedded daemon host so TCC grants attribute to BotFleet | `cua.mjs:191-220` | **BF-2499** — a stable identity is what makes attribution work |
| Standalone daemon attach via `/Applications/CuaDriver.app` | `cua.mjs:156-189` | **BF-2499** |
| Persist the connection descriptor to `userData/cua-connection.json` for drivers | `cua-connection.cjs`, `cua.mjs:109-113` | **BF-2509** — a process-boundary handoff the native protocol replaces |
| Permission status via `cua-driver permissions status --json` | `cua-permissions-status.mjs`, `cua.mjs:268-301` | **BF-2499** (revocation detection) |
| Stop the daemon, invalidate the descriptor, bounded 2.5 s cleanup before quit | `cua.mjs:303-324`, `main.mjs:3175` | **BF-2499** — "CUA safety stop" is the issue title |
| Linux runtime, AppImage bundle staging, hash verification (~1,905 lines) | `cua-linux.cjs`, `cua-linux-runtime.cjs`, `cua-linux-bundle.cjs` | **retire** (BF-2500) |
| Screen preview (display-media guard, source selection) | `screen-preview.cjs`, `main.mjs:2056-2070`, `:3018-3068` | **BF-2481** (ScreenCaptureKit) |
| Embedded noVNC viewer window and split workspace panes | `desktop-viewer.cjs`, `desktop-workspace.cjs`, `main.mjs:1662-1762` | **new issue** — a sandboxed remote browser with its own partition; a native `WKWebView` with the same isolation, or a native VNC client |
| Android device control over USB `adb` | `android-device.mjs` | **retire** — no Mac story in Option A |

## 6. Shell, menu, and window surfaces

| Responsibility | Today | Native owner |
|---|---|---|
| Application menu (BotFleet / File / Edit / View / Window / Help), accelerators, roles, Settings deep links | `main.mjs:2647-2889` | **BF-2479** (done) + **BF-2501** (deep links) |
| Menu-to-Settings deep-link contract against the renderer's section union | `application-menu.test.mjs:38-69` | **BF-2501** — the contract survives as a Swift test |
| Tray icon and context menu (Show, Settings…, Server Controls…, Quit) | `main.mjs:2965-2989` | **BF-2484** (`NSStatusItem`) |
| Native text context menu (spellcheck, Copy Link, edit roles) | `main.mjs:1883-1915` | **BF-2501** |
| Unread count → dock badge | `main.mjs:321-333`, `:1818-1823` | **BF-2484** (surface) + **BF-2501** (source) |
| Window state persistence (`window-state.json`) | `window-state.cjs`, `main.mjs:268-300` | **BF-2479** (done) — `NSWindow.setFrameAutosaveName` replaces the file |
| `botfleet://` protocol and `botfleet://install?url=` deep link with a GitHub-host allowlist | `package-link.mjs`, `main.mjs:352-386` | **BF-2495** (import) + **BF-2497** (URL handling) — the allowlist belongs in the acceptance criteria |
| Renderer trust boundary (origin check + IPC guard over every handler) | `renderer-trust.mjs`, `main.mjs:1623`, `:1871-1878` | **retire** (BF-2485) |
| Save / open / reveal file, pick folder, open external URL | `save-file.mjs`, `open-file.mjs`, `external-url.mjs`, `main.mjs:2101-2219` | **BF-2501** (`NSOpenPanel` / `NSSavePanel`) |
| Speech and Personal Voice lifecycle | `speech.mjs`, `main.mjs:2289-2327` | **BF-2483** |
| Skill recorder (screen + audio capture → skill definition) | `skill-recorder.mjs`, `build-recorder-helper.mjs` | **new issue** — not named in any rewrite issue |
| AssemblyAI streaming token and the permanent key in the encrypted store | `assemblyai.mjs`, `main.mjs:2413-2433` | **BF-2483** (voice) + **BF-2506** (key storage) |
| Microphone / Screen Recording permission panes, System Settings deep links | `main.mjs:2258-2287` | **BF-2499** |
| Engine terminal launch (`engine:open-terminal`) | `terminal-launch.mjs`, `main.mjs:2089-2093` | **BF-2504** |
| Desktop Sentry init, release SHA resolution, request scrubbing | `main.mjs:149-230` | **new issue** — Sentry Cocoa for the native app |
| Desktop capability and version surface | `capabilities.cjs`, `app-info.cjs`, `main.mjs:2392-2411` | **BF-2501** — small, but it should be named so the parity harness can assert it |
| Native version probe of a checksum-verified binary | `native-version-probe.mjs` | **BF-2486** (updater) and **BF-2510** (tunnel) |
| Build scripts: speech helper, recorder helper, Control app | `build-speech-helper.mjs`, `build-recorder-helper.mjs`, `build-control-app.mjs` | **BF-2483** (speech), **BF-2499** (recorder signing), **mac-control** (Control app) |
| Control bundle version and build number (pinned app/marketing versions on the ordering line, stamp-script fallback, `BOTFLEET_SKIP_VERSION_STAMP=1` bypass) | `control-build-version.mjs`, `build-control-app.mjs:72-81` | **BF-2486** (version source) + **mac-control** (Control bundle) |
| Helper bundle identity plists (`app.botfleet.speech.macos`, `app.botfleet.recorder.macos`) | `electron/resources/*-Info.plist` | **BF-2483** / **BF-2499** |
| `window-chrome.mjs`, `skin-overlay.cjs` (per-skin chrome table) | 12 + 40 lines | **BF-2501** |

## 7. The iOS companion path — settled by BF-2510 and BF-2511

These nine exist only to serve a paired phone, so none of them can be
deferred past the endpoint decision.

1. Device-facing listener and its default-deny allowlist (`:8810`, `:8811`,
   SSE `/api/events`) — **BF-2510** decides in-app versus slim host,
   **BF-2511** builds it.
2. Private origin socket plus the 8812 guardian gateway — **BF-2510**.
3. Hosted route provisioning and account onboarding — **BF-2510 / BF-2511**.
4. Pairing, device registry, revocation, per-device cloud-desktop grant —
   **BF-2510 / BF-2511**.
5. Discovery and presence (Bonjour/mDNS, LAN versus hosted route, Tailscale) —
   **BF-2511**.
6. APNs push relay — **BF-2511**; the provider JWT stays server-side.
7. Keep-awake while phone access is on — implementation **BF-2484**, product
   contract **BF-2510 / BF-2511**.
8. The "Phone (Companion Access…)" Settings section and its menu deep link —
   pane **BF-2501**, backing API **BF-2511**.
9. Remote wake gates — the server half is done (BF-2489); the endpoint the
   phone calls is **BF-2510**.

## 8. What must move to the harness or launchd now

BF-2498 also asks that anything Jay needs daily — the iOS companion path
first — be moved out of Electron before the rewrite, so the daily path does
not wait for the native shell. Two candidates are already in the right place
and need no new work:

* **The companion sidecar is already a launchd agent**
  (`scripts/launchd/app.botfleet.companion.plist`, supervised by
  `electron/managed-companion-supervisor.mjs`). The phone path does not
  depend on the Electron app being open; it depends on the supervisor
  surviving Electron's exit, which `managed-companion-guardian.mjs` and the
  runtime-claim re-proof already handle.
* **The harness is already a launchd agent**
  (`scripts/launchd/app.botfleet.server.plist`).

So the daily path is already decoupled from Electron. The remaining coupling
is the *hosted* route: the hosted connector, the account service, and
the origin gateway all live in the Electron main process today. Moving the
hosted route under launchd — so a paired phone reaches the Mac with the
desktop app closed — is the one piece of BF-2498's "move it now" clause that
is still outstanding, and it lands with **BF-2510**'s decision, because the
route's implementation depends on whether the sidecar survives.

## 9. Gaps — responsibilities with no owner today

These need new issues before Phase 3 can start; each is small but each is a
real product surface.

1. **Native diagnostics bundle and bug-report export.** `diagnostics.mjs`
   (redaction, the `CREDENTIAL_ENV_NAMES` mirror of the server list, log
   tail), `main.mjs:1068-1094` (`gatherDiagnostics`), `:2114-2136`
   (`desktop:export-diagnostics`). Not in the BF-2502 inventory. — **BF-2538**
2. **Native embedded remote-desktop viewer with session isolation.**
   `desktop-viewer.cjs`, `desktop-workspace.cjs`. A `WKWebView` with the
   same origin and permission rules, or a native VNC/RDP client. — **BF-2539**
3. **Native skill recorder** — capture to skill definition, plus the
   `app.botfleet.recorder.macos` helper's signing story. — **BF-2540**
4. **Sentry Cocoa for the native app** — release SHA stamping and request
   scrubbing. The BF-2502 inventory marks this "Phase 3, no covering issue".
   — **BF-2541**
5. **Desktop capability and version surface** — fold into **BF-2501**, but
   name it so the parity harness can assert it.
6. **The `botfleet://install` allowlist** — the native URL handler must
   reproduce `package-link.mjs` exactly; that belongs in **BF-2495**'s
   acceptance criteria.
7. **Native version probe** — fold into **BF-2486** and **BF-2510** rather
   than leaving it unowned.

## 10. Install and cutover (BF-2498's other half)

BF-2498 also asks for a Developer ID-signed native build installed as the one
copy at `~/Applications/BotFleet.app` (bundle id `app.botfleet.macos`, dev
builds keeping a distinct bundle id), so `open -a BotFleet` — what
`POST /api/desktop/open` and the iPhone's "Open on Mac" button run —
launches the native app. Launching starts the launchd harness when it is down
and removes `~/.botfleet/stopped.marker`. The Electron app moves out of
`~/Applications` and Login Items into a rollback archive, and is not deleted
until the soak sign-off.

State of each piece, from the tree:

* `electron/server-controls.mjs:30-90` already installs
  `BotFleet Control.app` into `~/Applications` with an identity check and a
  symlink-safe copy. That install path is the model the native app's install
  should follow.
* The startup-marker half is already native: `mac-control/Sources/BotFleetControlCore/StartupPolicy.swift`
  owns `startup-session`, `startup-disabled.marker`, `startup-enabled.marker`,
  and `stopped.marker`, and `scripts/botfleet-server-start.sh` honours them.
  The native app only has to remove `stopped.marker` on launch, which
  **BF-2497** covers.
* `POST /api/desktop/open` lives in `server/desktop-open.ts` and runs
  `open -a BotFleet`. Both bundles share the name `BotFleet` and the bundle
  id `app.botfleet.macos` (the native target installs over the Electron
  shell), so the endpoint needs no retarget: it opens whichever
  `BotFleet.app` is installed. That is still a **BF-2514** row, because the
  endpoint dies with the Node harness.
* The 7-day soak sign-off is Jay's, and it is gated on the native app being
  the daily driver — which is the BF-2497 deliverable.

## 11. Sequencing

* **BF-2499** (stable Developer ID signing) gates **BF-2506** (Keychain):
  the Electron store is a safeStorage blob bound to the code-signing
  identity, and the 2026-09-22 bundle-id migration already documents that a
  rename invalidates it. The native Keychain item must be created under the
  final identity, or a second migration lands.
* **BF-2497** gates **BF-2514**: the native app must own harness
  attach/spawn, quit policy, and the startup markers before the
  `app.botfleet.server` LaunchAgent retires.
* **BF-2510** gates **BF-2511** and every row in §2 and §7.
* **BF-2502**'s inventory and this file together are the Phase 4 gate for
  BF-2514 and BF-2515. A new `electron/` file after this commit needs a row
  here before Phase 5 starts.
