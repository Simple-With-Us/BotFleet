# The BotFleet Control-Plane Single-Writer Contract (BF-2514)

Measured against the two live hosts on Mon, Nov 2, 2026 and the tree at `98100425`.  This contract states which host writes the BotFleet control plane, how a reader knows which writer is live, what must be proven before the old writer is retired, and what the rollback is.  The ordered commands and their expected output are in [the companion cutover runbook](native-rewrite-single-writer-cutover.md) (BF-2514).

## Scope

This contract governs the **fleet's** control plane: the harness state, the bot roster, the routine schedule, the webhook registry, the Zulip subscription and the job queue, on whichever host runs the always-on harness.  Two hosts can run that harness today: the Mac's `app.botfleet.server` LaunchAgent and the Linux server's `botfleet-server.service`.  Exactly one of them may write.

Three things this contract does not do.

-  It does not choose a product default.  BF-2544 owns the optional server mode, and Jay's Oct 25 and Oct 29 rulings stand: server-first is an opt-in configured mode, and a fresh Mac-only install is complete on its own with exactly one harness, on the Mac.  The rule this contract states is per **selected mode**, not per product.  Each mode has exactly one writer and the mode fixes which host it is.  The modes themselves belong to BF-2544 and to `docs/plans/2026-10-29-native-server-mode.md`; this contract does not define them.  What it says about them is narrow:  in a Mac-only deployment the writer is that Mac's own harness and there is no second candidate host, so nothing here asks a standalone install to have a server;  in Jay's configured server-first deployment the writer is the server, and the cutover and the retirement below are what remove the Mac's harness from that deployment's writer role.  What the contract forbids in every mode is two hosts writing the same surface at once.
-  It does not touch the Node-removal validation.  That is BF-2515 (AG), in `docs/native-rewrite-decommission-runbook.md`.
-  It does not touch the native app's composition.  That is MC's lane, under BF-2504 and BF-2511.

## Why A Second Writer Is A Fault And Not A Quirk

The codebase already has an ownership fence, and it is the wrong shape for this question.  [electron/harness-ownership.mjs](../electron/harness-ownership.mjs#L56) writes `harness-owner.json` into the data root under a file lock: `{ version, pid, port, nonce }`, and refuses a second harness on the **same** data root while the recorded pid is alive.  The liveness test is deliberately fail-closed, so an inaccessible or reused pid is treated as alive (`isAlive` returns true for anything but `ESRCH`).

That fence is exactly right for one machine, and exactly no help across two.  The Mac's harness owns `~/.botfleet` and the server's harness owns `/mnt/fleet-extra/apps/botfleet-server/data`.  Each holds a valid, live ownership record, and neither can see the other's.  Both hosts run the same harness code (`server/index.ts`), against the same store schema, with the same bot ids.  The two writers are therefore not merely two processes; they are two processes writing **the same logical state** under **different paths**.

Whatever state both hosts can reach is state that can diverge, and today one routine can.

## The Measured Inventory

Taken from the live hosts on Mon, Nov 2, 2026.  The Mac is reachable over `ssh mac`; the server is `fleet-hetzner-nbg1`.

### The Mac's writer

| Item | Value |
|---|---|
| Launch agent | `~/Library/LaunchAgents/app.botfleet.server.plist`, label `app.botfleet.server` |
| Tracked source | [scripts/launchd/app.botfleet.server.plist](../scripts/launchd/app.botfleet.server.plist) |
| Wrapper | `~/apps/botfleet-server-start.sh` (tracked source [scripts/botfleet-server-start.sh](../scripts/botfleet-server-start.sh)) |
| Runtime root | `BOTFLEET_SERVER_ROOT=/Users/jay/.botfleet/current`, a symlink into the immutable release store `~/.botfleet/releases/2f73abd1e043994d76d0f11b3d0599a60551f279` |
| State root | `~/.botfleet` (`bots.json`, `config.json`, `messages.db`, `runtime.db`, `routines.json`, `webhooks.json`, `jobs/`, `events/`, `item-io/`, `native/`, `workspaces/`, `attachments/`) |
| Listeners | `127.0.0.1:8799` (harness) and `127.0.0.1:8800` (webhook receiver), both held by pid `2369` at the time of the survey |
| Supervision | `KeepAlive.SuccessfulExit=false` plus `StartInterval=300`; the wrapper probes `:8799` and exits 0 when healthy, so the periodic run is a health check rather than a restart loop |
| Launch state at survey | Loaded and running: `launchctl print gui/501/app.botfleet.server` reports `state = running`, `runs = 310`, `last exit code = 0` |
| Launchd job environment | `HOME`, `PATH` and `BOTFLEET_SERVER_ROOT` only, as `launchctl print` reports it |
| Infisical | **Reports itself off.**  `GET /api/infisical/status` answers `{"configured":false,"enabled":false,"source":"none","projectId":null,"hasClientId":true,"hasClientSecret":false,"vaultCount":0}`. |
| Zulip bridge | **Disabled for all 12 bots.**  The harness's own Infisical status answers `configured: false` and `enabled: false`, so every scoped read is refused before a request is made, and the log repeats every five minutes: `[zulip] <bot>: disabled — cannot read Infisical 9bf7417a-… prod /zulip: Infisical is not configured and turned on for this workspace.` |
| Mac-only capabilities it carries today | The public webhook ingress, the Local VM, the iMessage relay, screen capture and desktop control |
| Public ingress | `https://botfleet.jays.services` reaches the **Mac's** harness:  `curl -sf https://botfleet.jays.services/api/health` answers `{"app":"botfleet","pid":2369,…}`, which is the Mac's pid and not the server's `2239131`.  The tunnel is the Mac's `cloudflared` process |

### The server's writer

| Item | Value |
|---|---|
| Unit | `botfleet-server.service`, `enabled`, `Active: active (running)` since Nov 1, 15:22 |
| Unit source | [deploy/linux-server/botfleet-server.service.in](../deploy/linux-server/botfleet-server.service.in) |
| ExecStart | `/mnt/fleet-extra/apps/botfleet-server/node/bin/node --experimental-strip-types /mnt/fleet-extra/Code/BotFleet-server/server/index.ts` |
| Runtime root | `BF_ROOT=/mnt/fleet-extra/apps/botfleet-server` |
| State root | `OMB_DATA_DIR=/mnt/fleet-extra/apps/botfleet-server/data`, same file names as the Mac's |
| Listeners | `127.0.0.1:8799`, `127.0.0.1:8800`, `100.69.77.26:8799` (tailnet) and `[fd7a:…]:8799` |
| Owner gate | `deploy/linux-server/owner-gate.mjs` in front of the harness on `127.0.0.1:8798`; a tailnet request carries `x-botfleet-gate-token` |
| Environment | `EnvironmentFile=/mnt/fleet-extra/apps/botfleet-server/config/server.env`, which sets `INFISICAL_PROJECT_ID` and `INFISICAL_TOKEN` |
| Infisical | **Configured and live.**  `GET /api/infisical/status` answers `{"configured":true,"enabled":true,"source":"env","projectId":"836aebe2-c8f7-4e09-978e-7e3e82500bce","hasToken":true,"vaultCount":44}`, with no last error |
| Zulip bridge | **Enabled.**  The server processed a live inbound message for `BF-Director` on Nov 2 at 22:10 UTC and carries a `data/zulip/` spool that the Mac does not have |
| Sandbox | `ProtectSystem=strict`, `ReadWritePaths=/mnt/fleet-extra`, `PrivateTmp`, `ProtectControlGroups`, `KillMode=mixed`; the unit also has `AllowedCPUs` and `CPUWeight` drop-ins |

### Where the two writers overlap

| Surface | Mac | Server | Both write it |
|---|---|---|---|
| Bot roster | 12 bots, 11 on (`BF-Trader` off) | 13 bots, all 12 shared ones on, plus `Telemetry Verification` | **No, not today.**  The 12 shared bot ids carry the same roster, but the Mac's Zulip bridge is disabled, so the Mac writes no bot thread state |
| Routine schedule | 24 routines, **16 enabled** | 24 routines, **1 enabled** | **Yes.**  Exactly one routine, `6d74f498` *Fleet RAG Nightly Ingest*, is enabled on **both** hosts, with the same schedule and the same `nextRunAt`, so two schedulers own one occurrence |
| Routine runs | 16 enabled | 1 enabled | **Yes.**  Eight run records carry identical ids and identical timestamps on both hosts, which shows the two stores were one store before they forked;  after the fork the two schedulers claimed the Nov 2, 2:30am occurrence independently |
| Webhook registry | 7 endpoints, **6 enabled** | 7 endpoints, **0 enabled** | **No.**  The Mac's delivery counts are ahead of the server's (`9795` against `9724` on `wh_vvtRtSSe6n64Y0AL`), so the Mac is receiving the live webhook traffic |
| Store schema | `bots.json`, `config.json`, `messages.db`, `runtime.db`, `routines.json`, `webhooks.json`, `jobs/`, `events/`, `item-io/`, `native/`, `workspaces/` | the same names | **Structurally yes.**  Two divergent copies of one logical schema, each with its own `harness-owner.json` |
| Infisical | `configured: false`, `enabled: false`, `vaultCount: 0` | `configured: true`, `enabled: true`, `vaultCount: 44` | No, and the gap is not cosmetic: the Mac cannot read the vault at all |
| Zulip | disabled; the harness's own Infisical status answers `configured: false` | enabled; the same route answers `configured: true` with 44 vault entries | No |
| Job queue | `jobs/` in the Mac's store | `jobs/` in the server's store | Structurally yes |

The one live double-write is `6d74f498` *Fleet RAG Nightly Ingest*, owned by `BF-Oracle` (`79a3a7f8`).  It is enabled on both hosts, with the same daily 02:30 America/Chicago schedule and the same `nextRunAt`.  After the stores forked, the two schedulers claimed the Nov 2, 2:30am occurrence independently:  the server's run `876fc687` started at 2:30:07am and **failed** with `VPS is not configured`, and the Mac's run `abe48778` is **missed** because that host was offline for more than 12 hours.  So the defect is **double ownership of one occurrence**, not two completed executions of it;  the next occurrence, Nov 3 at 2:30am, is the first in which two completed executions are possible.

## The Rule

### One writer per surface, and one writer per deployment

**Exactly one host may write the control plane for a given BotFleet deployment, in the mode that deployment has selected.**  After the BF-2514 cutover the writer for Jay's server-first deployment is the **Linux server**, because BF-2544 is what makes the server the writer.  The Mac stops writing at the moment its launch agent is booted out, and it does not resume writing unless the rollback in this document is executed.  A Mac-only deployment is not affected:  its writer is its own harness, and this contract never asks it to have a server.

The rule is about **writing**, not about running.  The Mac may remain a *worker* for Mac-only capabilities (desktop control, screen capture, the Local VM, the iMessage relay) under the ownership model BF-2544 and BF-2559 define.  A worker holds a lease and reports results; it never owns a record it can act on alone.

### What happens to a second writer the moment the cutover happens

Three things, in this order, and none of them is optional.

1.  **The old writer stops.**  `launchctl bootout gui/$(id -u)/app.botfleet.server` removes the job.  Because the plist carries `StartInterval=300`, a booted-out job cannot come back on its own; but `launchctl enable` and `launchctl bootstrap` must also be undone, or the next login re-registers it and the second writer returns with nobody watching.
2.  **The old writer's data root stops being a target.**  `~/.botfleet/harness-owner.json` keeps naming the dead pid until the next harness starts there.  The record is harmless on its own, and it must be left in place as the rollback handle; it is not the fence.
3.  **Any surface the old writer still had enabled is disabled or migrated on the new writer first.**  This is the step that prevents the divergence above: a routine enabled on both hosts is a double-write, and it must be disabled on the old writer **before** the old writer is stopped, not after.

The order matters.  Disabling shared surfaces first, then booting the old writer out, then proving the new writer, is the only order in which a failure leaves one writer rather than two.

### How a reader knows which writer is live

Until the native epoch fence in `docs/plans/2026-10-29-native-server-mode.md` lands, there is no single record that names the control plane's writer, and this contract does not invent one.  A reader answers the question from the two launch paths themselves, and both must agree.

| Question | Mac | Server |
|---|---|---|
| Is the job loaded? | `launchctl print gui/$(id -u)/app.botfleet.server` finds a service | `systemctl is-active botfleet-server.service` is `active` |
| Who is the process? | `launchctl print` names `pid` and `port` | `systemctl show botfleet-server.service -p MainPID` names it |
| Does it answer? | `curl -sf http://127.0.0.1:8799/health` returns 200 | `curl -sf http://100.69.77.26:8799/health` returns 200 behind the owner gate |

**Exactly one of those two columns may be true.**  If both are true, the deployment has two writers and the contract is violated; that is the alarm condition, and the response is to stop the Mac's harness first, because the server is the writer.  If neither is true, the deployment has no writer and the response is the rollback.

The health route answers `/health` and `/api/health` with `app`, `pid`, `ready` and `booting` ([server/index.ts](../server/index.ts#L885)); the `pid` is what makes the answer checkable rather than a bare liveness string.

## What Must Be Proven Before The Old Writer Is Retired

Six items.  Each has a command and an expected output in [the cutover runbook](native-rewrite-single-writer-cutover.md); the list here is the gate.

1.  **The server is the single writer.**  Its harness answers the health route, its Zulip bridge is enabled, and it is the only host with a live subscription.
2.  **No surface is enabled on both hosts.**  The routine registry, the webhook registry and the bot roster are compared, and every id enabled on the Mac is disabled or migrated first.
3.  **The Mac app is pointed at the server.**  It reads and writes through the server, and the local `:8799` is no longer its target.
4.  **Mac-only capability still works.**  Desktop control, screen capture, the Local VM and the iMessage relay are not collateral damage of the cutover; they are the reason the Mac keeps a role.
5.  **A full day passes with the Mac's harness stopped.**  Every bot answers, every routine fires on schedule, Zulip and Linear round-trip, and the webhook receiver still receives.
6.  **The rollback has been rehearsed once.**  Restoring the Mac's harness against the archived store has been done, not assumed.

Only then does the launch agent get retired.  The decommission runbook's Step 2 makes the same ordering: "**Precondition:** BF-2514 Done, `soak-24h-no-node` asserted, and `app.botfleet.server` confirmed booted out with `launchctl print` showing no job."

## Rollback

The rollback is **restore the old writer**, not restore the code.

-  **Restore the launch path.**  `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.botfleet.server.plist`, then `launchctl enable gui/$(id -u)/app.botfleet.server`.  The plist and the wrapper stay in the repository and on the Mac until the retirement has actually run.
-  **Restore the store.**  The Mac's data root is untouched by the cutover: the cutover changes which host is the writer, it does not migrate the Mac's store.  If the Mac's store was archived or re-imported, restore it from the archive the way BF-2515's Step 1 does, and boot the harness against it.
-  **Re-disable the surfaces the server owns.**  The server's routine and webhook enablement is reverted before the Mac's harness resumes writing, so the double-write does not simply come back.
-  **Then, and only then, re-enable the Mac's subscriptions.**  Re-enabling the Mac's Zulip bridge needs the Infisical project id and token the LaunchAgent's environment does not carry today; that gap is a finding of this inventory, not a cutover step.

Rolling back does not need the server to be stopped, because the server and the Mac write different stores and different external surfaces once the shared surfaces are disabled on one side.  It does need the shared surfaces to be disabled on exactly one host at a time.

## Change Control

This contract changes only when the owner changes the deployment, and any change to it must state the new writer, the new reader's discovery method, and the rollback.  A change that would make two hosts write the same surface again is a regression against BF-2514 and BF-2544's "never create competing authoritative writers" clause.

The decommission runbook (`docs/native-rewrite-decommission-runbook.md`) and the port inventory (`docs/native-rewrite-port-inventory.md`) are the companion documents; this contract owns the *who writes* question and those own the *what replaces what* and *when* questions.

## The Register

The Mac's process inventory lives outside this repository, at `/Users/jay/apps/MAC-LOCAL-PROCESSES.md`, and it is the live source of truth for the Mac's background jobs.  **This repository carries no copy of that file at all**:  `git ls-files` has never listed it and `git log --all -- docs/MAC-LOCAL-PROCESSES.md` is empty, so there is no mirror here to regenerate and nothing to keep in step in this tree.  The file's own header names its GitHub home as `Simple-With-Us/AI-Fleet-Coordinator`, `docs/MAC-LOCAL-PROCESSES.md`, which is a different repository and outside this change's ownership.  That mirror is therefore behind after this change and needs the AFC owner to sync the live copy.  The `app.botfleet.server` row, the `~/apps/botfleet-server-start.sh` row and the `app.botfleet.server via ~/apps/botfleet-server-start.sh` row in the live file are the Mac-side record of the job this contract retires, and all three were updated on Nov 2, 2026 with the current truth and the retirement plan.  The Apple Note `[BF, MM] Single-Writer Cutover And Harness Retirement (BF-2514)` carries the same statement for the owner.
