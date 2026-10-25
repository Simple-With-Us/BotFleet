# BotFleet Native macOS Rewrite — Port Inventory (BF-2502)

Source of truth for what happens to every Node subsystem when the harness goes
native. Gated-by reference for **BF-2514** (Phase 5 single-writer cutover and
`app.botfleet.server` LaunchAgent retirement) and **BF-2515** (Phase 6 Node
decommission): neither lands until every row below has a Swift owner or a
retired reason.

Surveyed at commit `c7902d63` (2026-10-21), re-counted 2026-10-25:
`server/` 374 non-test files, ~142,800 lines · `companion/src/` 17 files,
~11,330 lines · `shared/` 58 non-test files, ~11,050 lines (zero `node:`
imports in source — only the three `*.test.ts` files reach for `node:fs`, so
the portable set really is portable) · `electron/` 122 `.mjs`/`.cjs` files,
135 tracked in total.

Phases (reconstructed from the rewrite issue texts; `*` = no covering issue
yet, file a follow-up before Phase 5):
Phase 1 — foundation: storage, importer, perf budget, this inventory,
fixtures. Phase 2 — engine runtime port. Phase 3 — native shell, Electron off,
device endpoints. Phase 4 — Swift service layer (comms, routines, credentials).
Phase 5 — cutover (BF-2514). Phase 6 — decommission (BF-2515, BF-2485, BF-2486,
BF-2500).

Owner modules: `DatabaseService` (BF-2480), `ImportTool` (BF-2495),
`PerfBudget` (BF-2496), `ReplayHarness` (BF-2503), `EngineDriver` /
`EngineCoordinator` (BF-2504), `ACPActor` (BF-2505),
`InfisicalResolver` (BF-2506), remaining drivers (BF-2507), native runners
(BF-2482), per-bot switch (BF-2508), `CUAEngine` (BF-2509), `ZulipEventActor` +
Linear sync (BF-2512), `RoutinesScheduler` (BF-2513), iOS endpoint decision
(BF-2510) and build (BF-2511), `MenuBarExtra` (BF-2484), `VoiceService`
(BF-2483), `ScreenCaptureService` (BF-2481), `LifecycleService` (BF-2497),
`TextKitTranscript` (BF-2501), `UpdateService`/Sparkle (BF-2486), daily-driver
cutover (BF-2498), signing/TCC (BF-2499).

## 1. Engine drivers → Phase 2

| Node file(s) | Swift owner |
|---|---|
| `server/drivers/claude.ts`, `codex.ts`, `pi.ts`, `antigravity.ts`, `droid` (acp), `cursor` (acp), `kimi` (acp), `qwen` (acp), `hermes` (acp), `deepseek` (acp) | Native runners BF-2482; quirks actors BF-2505 |
| `server/drivers/acp/core.ts`, `init-deadline.ts`, `prompt-budget.ts`, `turn-mcp.ts`, `dsh-acp-bridge.ts`, `opencode-go.ts`, `muse-msp-bridge.ts`, `muse.ts` (acp), `mcode.ts` (acp), `grok.ts` (acp), `dsh.ts`, `dsh-mcp.ts`, `native.ts` | `ACPActor` BF-2505 |
| `server/drivers/minimax.ts`, `openai-compat.ts`, `model-discovery.ts`, `chat-completions/{credentials,errors,loop,pricing,replay-cap,usage}.ts`, `local-inject.ts`, `grok.ts` (chat-completions replay), `boxagent.ts` | Direct LLM clients BF-2506; chat-completions loop → `EngineDriver` BF-2504 |
| `server/drivers/antigravity-models.ts`, `claude-models.ts`, `codex-catalog.ts`, `engine-command-{allowlists,discovery,commands,cache}.ts`, `cursor-engine-commands.ts`, `prompt-split.ts`, `retry.ts`, `builtIn.ts` | `EngineDriver` support BF-2504; catalogs → model metadata BF-2507 |
| `server/drivers/{agents-proxy,dweb-proxy,phone-proxy,qdrant-proxy}.ts` | MCP-lane proxies → `EngineDriver` tool lane BF-2504; `phone-proxy` (Android USB) retired, no Mac story |
| `server/drivers/cli-wrapper.ts` | Generic CLI wrapper → `EngineDriver` BF-2507 |
| `server/harness/{bus,append-queue,registry}.ts` | Turn event bus → `EngineCoordinator` BF-2504 |
| `server/helpers/tracker.ts` | Helper progress → `EngineCoordinator` BF-2504 |
| `server/procs.ts`, `server/tools/process-group.ts` | Process-group spawn/kill → `EngineDriver` supervision BF-2504 |
| `server/permission-proxy.ts`, `server/computer-proxy.ts`, `server/mcp-bridge.ts`, `server/mcp-remote-proxy.ts` | Per-turn MCP/permission proxies → `EngineDriver` BF-2504 |
| `server/launch-identity.ts`, `server/contracts.ts`, `server/schema.ts`, `server/names.ts` | Launch contract + canonical types → `EngineDriver` BF-2504; contracts port as Swift protocols |
| `server/tool-fields.ts`, `server/turn-tools.ts`, `server/tools/{agents,computer,github,host,jobs,phone,prompts,recall,shell-env,zulip}.ts`, `server/tools/registry.ts`, `schedule.ts` | Tool catalog + executors → `EngineDriver` tool lane BF-2504 (HTTP-lane tools fold into actor methods) |
| `server/capability-profile.ts`, `server/computer-capability.ts`, `server/doomed-dispatch.ts`, `server/turn-safety.ts`, `server/turn-worktree-admission.ts` + wiring test | Dispatch gates → `EngineCoordinator` BF-2504 |
| `server/model-{context-windows,fallback,lineage,default-slots,rejections}.ts`, `server/retired-model-ids.ts`, `server/instance-models.ts`, `server/claude-models.ts`, `server/antigravity-models.ts` | Model metadata + fallback chains → BF-2507 (data tables port with `shared/model-lineage.ts`) |
| `server/engine-command-cache.ts` | Engine slash-command cache → `EngineDriver` BF-2504 |
| `server/system-prompt.ts`, `server/context-injection.ts`, `server/turn-context.ts`, `server/tool-row.ts` | Prompt assembly → `EngineDriver` BF-2504 (pure logic, port with fixtures) |
| `server/seat-prompt.ts`, `bots/_shared.md`, `bots/*.md` (11 seats) | Seat prompts → app resources, `LifecycleService` BF-2497 |
| `server/chief-of-staff.ts`, `server/botfleet-status-capsule.ts` | Roster/status capsule → `TurnDispatcherActor` input BF-2512 |
| `server/turn-{stats,watchdog}.ts`, `server/thread-wedge-guard.ts`, `server/repeat-detector.ts`, `server/mcode-lock-contention.ts` | Turn health → `EngineCoordinator` BF-2504 |
| `server/resume-recovery.ts`, `server/turn-worktree-admission.ts` | Resume/rebuild → `EngineDriver` BF-2504 + per-bot switch BF-2508 |
| `server/checkpoints.ts` | Per-turn workspace snapshots → `EngineDriver` BF-2504 (git-based, reimplement with libgit2 or `git` CLI) |
| `server/worktree-leases.ts` | Lease queue → `EngineDriver` BF-2504 |
| `server/testing/*` (28 fakes/harness files) | Retired; replaced by `ReplayHarness` fixtures BF-2503 |
| `server/provider-reload-order.test.ts` | Guards the module-scope provider reload fence in `server/index.ts` (the temporal-dead-zone read that surfaced as `provider_error`) → `EngineCoordinator` BF-2504, where the fence becomes actor state; the test retires with the file in BF-2515 |
| `server/index.ts` (composition root: routes, boot wiring, harness entry) | Wiring collapses into `LifecycleService` BF-2497 and the Phase 5 actors; the file itself retires BF-2515 |
| `server/cli-failure.ts`, `server/cli-probe-env.ts`, `server/stderr-excerpt.ts`, `server/host-dispatch-hot.ts` | Engine support (failure wording, credential-free probe env, shared host probe) → `EngineDriver` BF-2504 |
| `server/attachments.ts` | Composer attachment staging → `EngineDriver` tool lane BF-2504 |
| `server/bot-desktop-session.ts` | Shared-desktop identity → `CUAEngine` BF-2509, beside the `local-vm-*` rows |
| `server/cloud-backend.ts` | Cloud-backend switch guard → per-bot switch BF-2508 |
| `server/data-dir.ts`, `server/harness-ports.ts` | Data-root and port-ladder rules → app startup BF-2497 (twins of `electron/app-paths.mjs` and the `main.mjs` ladder) |
| `server/idempotency.ts` | Retry-safe POST outcomes → companion endpoint BF-2511 and `RoutinesScheduler` BF-2513 |
| `server/companion-writes.ts`, `server/named-tunnel-gate.ts` | Phone-write shapes and tunnel gate → the BF-2510 endpoint, built by BF-2511 |
| `server/replies.ts` | Reply excerpt rendering → `TextKitTranscript` BF-2501 (pure logic port) |
| `server/*-wiring.test.ts`, `server/*-e2e.test.ts`, `server/boot-*.test.ts`, `server/agent-docs-linear-board.test.ts`, `server/branching.test.ts`, `server/comms.test.ts`, `server/composer-attachments.test.ts`, `server/delete-refusal-routes.test.ts`, `server/drafts.test.ts`, `server/external-credential-startup.test.ts`, `server/fallback-tiers.test.ts`, `server/group-tasks.test.ts`, `server/harness-trust-boundary.test.ts`, `server/kill-tree.test.ts`, `server/max-tool-rounds.test.ts`, `server/mcp-server*.test.ts`, `server/mcp-sse*.test.ts`, `server/mcp-strict-handshake.test.ts`, `server/no-owner-defaults.test.ts`, `server/prompt-privacy.test.ts`, `server/retention-hold.test.ts`, `server/room-drain.test.ts`, `server/rooms-*.test.ts`, `server/secret-persistence.test.ts`, `server/task-*.test.ts`, `server/tasks.test.ts`, `server/unattended.test.ts`, `server/update-held-boot.test.ts`, `server/zulip-*.test.ts`, `server/bot-off*.test.ts` | Cross-cutting wiring, boot and lane tests.  Each ports with the subsystem it exercises (owners above); the corpus retires Phase 6 and replay coverage is BF-2503 |
| `server/test-parent-watchdog.ts` | Test harness; retired with `server/testing/*`, replaced by BF-2503 fixtures |
| `companion/README.md` | Pointer doc for the retired sidecar tree; deleted with it in BF-2515 |
| `electron/error-page.test.mjs`, `electron/sentry-desktop.node-test.mjs`, `electron/sts-packaging.node-test.mjs`, `server/sts-launch.node-test.mjs` | Boot-page, Sentry and STS packaging tests.  Each retires with its subject (`LifecycleService` BF-2497 boot page, Sentry Cocoa follow-up, BF-2489 STS) in BF-2485/BF-2515 |

## 2. Secrets and config → Phase 4 (BF-2506) unless noted

| Node file(s) | Swift owner |
|---|---|
| `server/infisical.ts`, `infisical-client.ts`, `secret-map.ts` | `InfisicalResolver` BF-2506 |
| `server/knob-map.ts`, `knob-write-through.ts`, `config.ts`, `config-reload-keys.ts`, `server/feature-flags.ts` + `feature-flags.json` | `InfisicalResolver` + app settings BF-2506; flags migrate to native settings store |
| `server/peer-approval-key.ts`, `permission-allow-key.ts`, `provider-tool-allow.ts`, `peer-approval.ts`, `server/tools/approvals.ts`, `server/auto-approve.ts`, `command-guard.ts`, `path-containment.ts`, `tool-policy.ts`, `review-watch.ts`, `auto-review.ts` | Approval/permission policy → `EngineDriver` turn lane BF-2504 (policy tables port as data) |
| `server/env-path.ts` | GUI-launch PATH augmentation → app startup BF-2497 (Finder-launch env) |
| `server/proxy-paths.ts`, `server/runtime-identity.ts` | Runtime path/identity → app startup BF-2497 |
| `server/atomic.ts`, `server/store-guard.ts` | Atomic writes + corrupt-store guard → `DatabaseService` BF-2480 (SQLite transactions subsume both) |
| `electron/infisical-read.mjs`, `electron/server-target.mjs`, `electron/remote-credential-guard.mjs` + their `.node-test.mjs` twins | Out-of-harness vault read, the `local`/`remote` server target, and the remote-mode credential refusal (BF-2544) → `InfisicalResolver` + app settings BF-2506; the target choice becomes native settings and the refusal rule ports as a guard on the native credential path |

## 3. Storage → Phase 1 (BF-2480, BF-2495)

| Node file(s) | Swift owner |
|---|---|
| `server/store.ts` (bots/threads), `message-db.ts`, `item-io-store.ts` | `DatabaseService` BF-2480 |
| `server/routines.ts`, `routine-requests.ts`, `server/runtime/store.ts`, `server/jobs/registry.ts`, `server/zulip/state.ts`, `server/zulip/outgoing-spool.ts`, `server/decision-log.ts`, `server/telemetry-outbox.ts`, `server/mcp-oauth-store.ts`, `server/plugin-registry.ts`, `server/workspace.ts`, `server/section-context.ts` | Flat-file stores → `DatabaseService` tables BF-2480; live rows migrate via `ImportTool` BF-2495 |
| `server/bot-package.ts`, `package-export.ts`, `team-manifest.ts`, `installed-playbooks.ts`, `playbook-install.ts`, `team-library.ts` | Package import/export → `ImportTool` BF-2495 (bot definitions ride the same importer) |
| `server/thread-events.ts`, `server/transcript-retention.ts`, per-thread `events/*.ndjson` + `native/*.ndjson` logs | Retention bounds → `DatabaseService` BF-2480; live frames feed `ReplayHarness` fixtures BF-2503 before the tee stops |
| `server/bot-cwd.ts`, `bot-directory.ts`, `bot-profile.ts`, `project-scout.ts`, `room-cwd.ts`, `task-workspace-context.ts`, `workspace-settings.ts` (shared) | Workspace/profile domain → `DatabaseService` schema BF-2480 + `shared/` Swift ports |

## 4. Comms and automation → Phase 4

| Node file(s) | Swift owner |
|---|---|
| `server/zulip/*` (23 files: client, hub, router, outbound, webhook, wire, credentials, format, mount, state, sentence-gap, outgoing-spool, types and their siblings) + `server/tools/zulip.ts`, `server/plugin-zulip-dispatch.ts` | `ZulipEventActor` + Linear sync BF-2512 |
| `server/webhooks.ts`, `webhook-ingress.ts`, `webhook-payload.ts`, `server/routes/linq-webhook.ts` | Webhook ingress → `RoutinesScheduler` BF-2513 |
| `server/routines.ts` (engine), `routine-requests.ts`, `resource-triggers.ts`, `trigger-gap.ts`, `automation-rollover.ts`, `ephemeral-dispatch.ts`, `room-queue.ts`, `room-turn-timeout.ts`, `room-cwd.ts`, `steer-queue.ts`, `member-turn.ts`, `delegations.ts`, `server/runtime/{runtime,envelope,level,tree,invariants,types}.ts`, `server/jobs/{admission,engine-fixtures,engine-lanes,mcp-lane,prompt,runner,sweep,wake,wake-usage}.ts`, `server/job-host.ts`, `server/update-turn-starter.ts`, `server/update-drain.ts`, `server/task-title.ts` | Scheduler + delegation runtime → `RoutinesScheduler` BF-2513; `update-drain` admission fence → cutover procedure BF-2514 |
| `server/linq/{client,dispatch,outbound,types}.ts`, `server/routes/linq-webhook.ts`, `server/tools/linq.ts` | Linq partner channel → Phase 4* (no covering issue; file follow-up: third comms actor or fold into `ZulipEventActor` pattern) |
| `server/notify.ts`, `server/sentry-crons.ts`, `server/comms-visibility.ts`, `server/chat-commands.ts`, `command-registry.ts` | Notifications + commands → Phase 4 (BF-2513 scheduler surfaces; command registry → native composer) |
| `server/sse-broadcast.ts`, `server/serialized-preview.ts` | SSE fan-out → in-process observation (no socket) Phase 4; backpressure tests become unit tests |

## 5. Companion sidecar → Phase 3 decision, Phase 5 cutover

| Node file(s) | Swift owner |
|---|---|
| `companion/src/proxy.ts`, `routes.ts`, `wire.ts` | Allowlisted device→harness policy → native `NetworkService` BF-2510 decision (option a: serve in-app; option b: slim companion host) |
| `companion/src/index.ts`, `listener.ts`, `lan-policy.ts`, `origin.ts` | Sockets/bind policy/private origin → app lifecycle BF-2497 + BF-2514 cutover |
| `companion/src/devices.ts`, `state.ts`, `control.ts` | Pairing + device registry → Keychain-backed `PairingService` BF-2510/2511 |
| `companion/src/mdns.ts`, `advertise-watch.ts`, `endpoints.ts`, `connected-devices.ts` | Discovery + presence → `NetworkService` (Network.framework/Bonjour) BF-2511 |
| `companion/src/apns.ts` | APNs provider → push relay BF-2511 (server-side JWT stays out of the app) |
| `companion/src/json.ts` | Trivial guards → fold into `NetworkService` |
| `companion/test/*` (19 files), `scripts/capture-companion-fixtures.mjs` | Retired Phase 6; iOS parity covered by native `XCTest` + BF-2503-style fixtures |
| `scripts/botfleet-companion-start.sh`, `scripts/launchd/app.botfleet.companion.plist`, `electron/managed-companion-*.mjs`, `electron/companion-*.mjs` | LaunchAgent supervision → retired Phase 5 BF-2514 (app as login item owns its sidecar or none) |
| `ios/Sources/CompanionCore/*`, `ios/App/*` | Already Swift; endpoint contract follows BF-2510 decision, build per BF-2511 |

## 6. Mac app shell and lifecycle → Phase 3 / Phase 5

| Node file(s) | Swift owner |
|---|---|
| `electron/main.mjs`, `server-boot-probe.mjs`, `harness-ownership.mjs`, `attached-ui-shim.mjs`, `single-instance.mjs` | App startup + harness attach/fork → `LifecycleService` BF-2497; shim retired (UI in-process) |
| `electron/server-controls.mjs`, `mac-control/Sources/BotFleetControlCore/*` (`ControlAPI`, `StartupPolicy`, `PersistencePolicy`, `OfflineDockerVM`, `OfflineVMHelper`) | Start/stop/status → `LifecycleService` BF-2497; control surface already Swift, keep |
| `scripts/botfleet-server-start.sh`, `scripts/launchd/app.botfleet.server.plist`, `scripts/botfleet-server-healthcheck.sh`, `scripts/launchd/harness-watchdog.node-test.mjs` | Always-on supervision → retired Phase 5 BF-2514 |
| `server/harness-lifecycle.ts`, `server/boot-recovery.ts`, `server/system-control.ts` | Deliberate-stop semantics + boot recovery → `LifecycleService` BF-2497, reused by BF-2514 cutover |
| `server/static-files.ts`, `server/console-timestamps.ts`, `server/log-dedup.ts` | Packaged-UI serving + log hygiene → retired (native UI/logging: `os_log`) Phase 3 |
| `electron/updater*.mjs`, `server/update-control.ts`, `scripts/update-botfleet*.mjs`, `scripts/update-botfleet*.sh`, `scripts/regenerate-*.mjs`, `scripts/stamp-commit-version.mjs` | Node updater → Sparkle pipeline BF-2486; Node scripts retired Phase 6 BF-2515 |
| `server/desktop-open.ts`, `server/sts-access.ts`, `server/sts-tokens.ts` (shared), `electron/sts-tokens.mjs` | Remote wake + STS minting → BF-2489 (done) + iOS endpoint BF-2510 |
| `server/desktop-probe.ts`, `server/screen-poller.ts` | Screen polling → `ScreenCaptureService` BF-2481 |
| `server/data-faults.ts`, `server/observability.ts`, `server/sentry*.ts`, `server/telemetry*.ts` | Crash/span reporting → Sentry Cocoa Phase 3* (no covering issue; file follow-up); fault banners → native UI |
| `server/gen-ai-cost.ts`, `server/rolling-spend.ts`, `server/ai-usage.ts`, `server/usage-quota.ts`, `server/usage-telemetry.ts`, `server/local-usage-monitor.ts`, `server/quota-window-map.ts`, `server/*-balance.ts`, `server/*-quota.ts` | Spend/quota ledgers → Phase 4* (no covering issue;-native cost ledger follow-up) |
| `electron/cua*.mjs/cjs`, `server/local-computer.ts`, `local-routing.ts`, `container-computer.ts`, `container-mcp.ts`, `container-runtime-guard.ts`, `local-vm-*.ts`, `desktop-open` viewers, `electron/desktop-*.cjs`, `screen-preview`, `skin-overlay` | CUA + Local VM → `CUAEngine` BF-2509; viewers → `ScreenCaptureService` BF-2481 |
| `server/vps-computer.ts`, `vps-container-mcp.ts`, `vps-shared-session.ts`, `server/remote-computer.ts` | BYO-VPS/self-host computers → retired, no Mac story in Option A |
| `server/box.ts`, `box-gateway-grant.ts` | Cloud-box computer → BF-2509 (confirm Mac story; hosted, no local runtime) |
| `server/computer-{call-gate,control,grants,observation}.ts`, `server/control-client.ts` | Computer arbitration → `CUAEngine` BF-2509 |
| `electron/speech*.mjs`, `build-speech-helper.mjs`, `build-recorder-helper.mjs`, `assemblyai.mjs`, `server/tts/*` (12 files), `server/recorded-message.ts`, `server/avatar-image.ts` | Voice pipeline → `VoiceService` BF-2483 (native Speech + AVAudioEngine); cloud TTS providers retire unless BF-2483 claims them |
| `electron/credential-*.mjs`, `electron/secure-credential*.mjs`, `electron/workspace-credentials.mjs`, `electron/config-file-lock.mjs` | Keychain/credential restore → `InfisicalResolver` + Keychain BF-2506 |
| `scripts/start-mcp-sse.sh`, `scripts/mcp-server.ts`, `scripts/mcp-sse.ts`, `server/mcp-server-config.ts`, `server/sse-*.ts` (server-side test helpers) | Dev MCP bridges → retired Phase 6 (in-process tools, no seats MCP token) |
| `server/mcp-{directory,gate,gate-config,registry,trim,probe,oauth,oauth-discovery,oauth-store,http,schema-validator}.ts`, `server/composio*.ts`, `server/connector-proxy.ts`, `connector-verdict.ts` | MCP catalog + OAuth + Composio bridge → `EngineDriver` MCP lane BF-2504; connected-app OAuth follow-up folds into BF-2506* |
| `server/plugin-*.ts`, `server/plugins.ts`, `server/skill-*.ts`, `server/skills.ts`, `server/qdrant-*.ts` (recall via `tools/recall.ts`, `recall-*.ts`) | Plugin/skill/recall hosts → Phase 4* (no covering issue; sandbox host + recall client follow-ups) |
| `server/bot-stop-policy.ts`, `server/turn-safety.ts` dispatch guards, `bot-power.ts` + `conversation-mode.ts` (shared) | Stop/power/mode semantics → `RoutinesScheduler` + UI BF-2513/BF-2501 |
| `server/redact.ts` → `shared/redact.ts`, `server/tool-activity.ts` (shared), `server/speech-spans.ts`, `spoken-script.ts`, `karaoke-align.ts`, `pronunciations.ts`, `voice-*.ts` (shared) | Portable domain logic → direct Swift ports, no owner issue needed; `redact` + `karaoke-align` are the two biggest algorithm ports |
| `server/terminology.ts` (shared), `conversation-mode.ts`, `thread-snooze.ts`, `busy-send-default.ts`, `workspace-settings.ts`, `bot-commands.ts`, `bot-avatar.ts`, `bot-profile.ts`, `model-lineage.ts`, `model-safety.ts`, `model-limits.ts`, `local-hosts.ts`, `local-auto-consent.ts`, `tool-scope*.ts`, `bypass-coverage.ts`, `container-runtime-name.ts`, `context-injection.ts`, `credential-request.ts`, `data-fault.ts`, `delegation-message.ts`, `helpers.ts`, `imessage-message.ts`, `item-io.ts`, `jobs.ts`, `outbound.ts`, `peer-refusals.ts`, `plugin-events.ts`, `plugin-manifest.ts`, `plugin-net-allow.ts`, `quota-plan-metadata.ts`, `routine-outcomes.ts`, `routine-request.ts`, `routine-retention.ts`, `run-on.ts`, `sign-in-request.ts`, `sts-tokens.ts`, `task-workspace-context.ts`, `text-format.ts`, `time-zone.ts` | All `shared/*.ts` → Swift value types Phase 1–4 alongside their feature owner; none are Node-blocked |

## 7. Consumers besides the Mac app

| Consumer | Uses | Native fate |
|---|---|---|
| iPhone app (`ios/`) | Companion `:8810` allowlisted routes + SSE; never `:8799` | Follows BF-2510 endpoint decision; build per BF-2511 |
| `BotFleet Control` (`mac-control/`, already Swift) | `:8799` health/control/config + LaunchAgent state + `BF_CONTROL_STARTUP_POLICY_V1` markers | Drives `LifecycleService` BF-2497; markers retired at BF-2514 |
| VM image (`scripts/computer-vm-cli/`, CI `vm-image-build.yml`) | `server/container-computer.ts` Dockerfile + `vm-cli-*.ts` | Keep image build (Local VM is Docker on Mac); thin CLI shims retire with Node Phase 6 |
| `cloudflare/composio-broker/` | None (no `:8799`/`:8810` calls) | Unaffected; self-host key path re-targets `InfisicalResolver` BF-2506 |
| `cloudflare/control-plane/` | Stub only, already removed | No action |
| Dev scripts (`e2e-server`, `smoke-packaged-server`, `bundle-server`, fixture capture, `vite.config.ts` proxy) | Boot harness on throwaway HOME | Retire with Node Phase 6; fixture capture superseded by BF-2503 |
| `apps/site`, `tools/`, `tv-face/` | None | Unaffected |

## 8. Retired with reason (no Swift owner)

- Windows/Linux desktop builds, NSIS scripts, PowerShell installers, `windows-*` CI jobs — BF-2500, Option A is macOS-only.
- `server/`, `companion/`, Node-only `shared/` shims (none today — shared is clean), desktop `package.json` build deps, Node CI jobs — BF-2515, after Phase 4 inventory gate (this doc) and Phase 5 cutover.
- Electron main + helpers + speech/recorder helpers — BF-2485, native shell BF-2479 replaces.
- Node updater + `update-botfleet*` scripts + feed tooling — BF-2486 Sparkle replaces.
- LaunchAgent plists + start scripts + healthcheck + watchdog test — BF-2514 retires supervision into the app login item.
- MCP SSE bridge + seat tokens, `e2e-server`, smoke/bundle scripts, vite dev proxy — dev-only, Phase 6.
- VPS/BYO computer paths (`vps-*.ts`, `remote-computer.ts`) — no Mac story in Option A.
- Android USB phone proxy — no Mac story in Option A.
- `server/testing/*` fakes — superseded by `ReplayHarness` fixtures BF-2503.
- Packaged-UI static serving, `attached-ui-shim`, renderer bridge preload surface — in-process native UI, Phase 3.
- `cloudflare/control-plane` stub — already dead, delete Phase 6.

## 9. Gate statement

BF-2514 and BF-2515 both cite this file as their Phase 4 inventory gate.  Coverage is re-checked by `scripts/audit-node-decommission.mjs` (BF-2515, 2026-10-24): every tracked file under `server/`, `companion/`, `shared/` and `electron/` must be named here or in the Electron inventory, and `scripts/check-decommission-gates.mjs` refuses the deletion until the Phase 5 issues and evidence are green.  Re-survey command for deltas:
`find server companion/src shared -maxdepth 1 -name '*.ts' ! -name '*.test.ts' | wc -l`
and per-area `wc -l`. Any new `server/` or `companion/` file after this
commit must land a row here before Phase 5 starts.
