# BF-2515 Phase 6 Decommission Gate Audit

Seat MM   audit, Nov 22 2026   read-only   no product change.

Lane `minimax-bf2515-gate-audit`   branch `minimax/bf2515-gate-audit`   branched from `origin/main` at `ccd2a04c7`.   The integration tree at `/mnt/fleet-extra/Code/BotFleet` was not edited, and nothing was pushed, posted to Linear or Zulip, deleted, installed, started or stopped.

Runtime was Node 26.13.1 (`/mnt/fleet-extra/apps/scratch/bin/node`), matching the CI runtime   the system node here is 22.22.1 and cannot import the repo's `.ts` modules.

Linear rows were read through this seat's own Linear route (MCP `linear_get_issue` / `linear_show`, identity MM).   The `simple-board` CLI on this host fails closed with `LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are not set in the environment`   so the repository's own state-refresh path could not read Linear   see finding 1 in section 4.

## 1. Gate By Gate

| Gate | Source-producible today | Exact blocker | Command and exit code | Where the output lives |
| --- | --- | --- | --- | --- |
| `placement-evidence` | No | The committed manifest asserts all sixteen recipes `false` and names no inventory artifact; the Mac host inventory has never been collected (`docs/verification/placement.md:42`); recipes 11, 12 and 13 need Jay present on the server with a recipe-specific go-ahead (`docs/verification/placement.md:56`); BF-2559 is In Progress. | `node scripts/check-placement-evidence.mjs docs/verification/placement-evidence.json` -> **exit 1** (16 unasserted keys, `inventory server` and `inventory mac` missing) | Run bundle is a private 0700 copy of `docs/verification/placement-evidence.json` plus relative artifact and hand-run log paths; the packet carries it as `placement.receipt.json`. |
| `soak-24h-no-node` | No | A 24-hour live run on the Mac with `app.botfleet.server` booted out and every bot answering.   Owned by BF-2514 and held for the owner (BF-2514 comment, Nov 18, 2026: "the live retirement, the bootout and the 24-hour no-Node run are the owner's").   `scripts/check-soak-24h.mjs` is a two-bookend check and not a soak producer (runbook line 168); the bundle receipt needs contiguous logged coverage segments with no gap. | Not run (would boot out a launchd job and stop the live harness on the owner's Mac) | Bundle receipt `no-mac-node-soak`. |
| `replay-parity` | No | The measurement producer `ios/Scripts/EngineReplayParityProbe` is Swift and needs Xcode, which this Linux host does not have; it also replays the recorded corpus, which has to be on the measuring host. | Not run (`swift`, `swiftc`, `xcodebuild` are all absent) | `capture/replay-parity.json` -> `replay.receipt.json` from `scripts/emit-replay-receipt.mjs`, 0600 inside a 0700 capture directory. |
| `final-import-parity` | No | Two inputs the producer cannot make for itself: the importer's Swift parity report (`ios/Scripts/StoreImportParityProbe`) and the owner's live Node store to archive read-only.   The archive step runs against the live store, which this audit is instructed not to touch. | Not run (`scripts/archive-node-store.mjs archive --store <live store> --out <dir>` reads the owner's live data) | Capture `import-parity.json` plus the read-only archive; receipts `import` and `rollback`. |
| `inventory-clean` | **Yes** | None.   It is a measurement of the committed tree, and the tree is clean. | `node scripts/audit-node-decommission.mjs` -> **exit 0** ("audited 1191 tracked files under server, companion, shared, electron, deploy against 2 inventory docs ... every audited file has an inventory row, or is a deliberately retained path") | stdout only;   `scripts/decommission-gate-state.mjs` runs the same audit and carries the boolean into the state file, where my fixture run wrote `"inventory-clean": true`. |
| `control-disposition` | No | The owner's Decision 1 (what BotFleet Control becomes after Node) is still unruled in `docs/plans/2026-10-29-botfleet-control-after-node.md:77-99`.   The Oct 30 ruling recorded at line 101 of that file is Decision 2 (the version handshake), not Decision 1.   The gate also wants a landed implementation and a Muster disposition (`REQUIRED_CHECKS["control-disposition"]` = `owner-decision`, `landed-implementation`, `muster-disposition`), and no producer for this receipt exists on main (runbook line 170). | No command; there is no producer to run | Bundle receipt `control-disposition`. |
| `linux-server-preservation` | No | An authorized executed Linux closure run.   `deploy/linux-server/retained-actual-adapters.mjs:17` `assertIsolatedNetwork()` requires a loopback-only Linux network namespace; this host has 40-plus non-loopback interfaces and non-`lo` routes in `/proc/net/route`, so the actual adapters refuse here.   The run also needs a bubblewrap private environment (`HOME=<root>/private-home`, `VITEST=true`, allowlisted env only) and it installs, starts, updates and rolls back a real service. | Not run (installs and starts a service; outside this audit's scope, and it refuses on this host anyway) | Capture `linux-retention.receipt.json` plus `actual-source-runtime-result.json` and the two closure receipts. |
| `macLocalHarness.present` | No | Only a Mac seat can verify the harness is gone, and only after BF-2514's cutover and the post-reboot check. | Not run (`scripts/check-post-reboot-node.mjs` needs macOS launchd; the verdict must carry `platform: darwin`, `launchProbes` and `launchDomain` or the receipt producer refuses it) | Bundle receipt `process-inventory`, with `macHarness: "absent"`. |

### The final CLI adds a gate that is not one of the seven booleans

`scripts/check-decommission-gates.mjs` requires the state file **and** a private, hashed receipt bundle bound to an explicitly selected source, build and signed artifact.   The bundle needs 13 receipts: `placement`, `import`, `replay`, `rollback`, `signed-release`, `linux-retention`, `process-inventory`, `control-disposition`, `change-plan`, `server-writer-soak`, `no-mac-node-soak`, `daily-driver`, `owner-acceptance`.

```
node scripts/check-decommission-gates.mjs <state.json> --bundle <bundle.json> \
  --source-sha <40-hex> --build <12-digit> --artifact-sha256 <64-hex>
```

Measured with a fixture packet in a 0700 directory: **exit 1**, with one `missing-receipt` blocker per kind.   Five of the thirteen have no producer on main at all (`server-writer-soak`, `no-mac-node-soak`, `daily-driver`, `signed-release`, `change-plan`), and `control-disposition` and `owner-acceptance` are human attestations by design (runbook line 170).   The collector confirms the same list: `node scripts/collect-decommission-evidence.mjs <request.json>` -> **exit 0** with all 13 named as missing and `"validation":"not-performed"`.

## 2. The Required Issue Rows

| Row | Linear state | Read via | This seat's to move |
| --- | --- | --- | --- |
| BF-2510 | Done | Linear MCP | No |
| BF-2511 | Done | Linear MCP | No |
| BF-2512 | Done | Linear MCP | No |
| BF-2513 | Done | Linear MCP | No |
| BF-2503 | Done | Linear MCP | No |
| BF-2504 | Done | Linear MCP | No |
| BF-2514 | **In Progress** | Linear MCP | **No, and not MM's to close.**   Assigned to Jay, labelled `Mac` and `seat:MM`; the Nov 18, 2026 comment records that the live retirement, the bootout and the 24-hour no-Node run are the owner's.   MM can supply the source and evidence side. |

Supporting rows read for context: BF-2515 In Progress (assigned Jay, labelled `claimed:MM` and `seat:MM`, so this seat holds the decommission row), BF-2559 In Progress, BF-2583 Done, BF-2544 Done, BF-2586 Done, BF-2495 Done, BF-2486 Done.   None of the supporting rows is one of the seven required rows.

The repository's own refresh tool agrees with the table and independently derives the one derivable gate: `node scripts/decommission-gate-state.mjs --board-json <nodes.json> --out <state.json>` -> **exit 0**, printing BF-2510 through BF-2504 `Done`, BF-2514 `In Progress`, `inventory-clean  true`, and the six human-only items left false.

## 3. The Shortest Honest Path To A Decommission Decision

Ordered by what actually gates what, with the owner of each step.

1. **BF-2514 cutover, on the Mac, by the owner.**   Retire `app.botfleet.server`, boot out the LaunchAgent, confirm `launchctl print gui/$(id -u)/app.botfleet.server` finds no service.   This is the precondition for the no-Node soak and for `macLocalHarness.present: false`.   Owner: Jay, on the Mac.
2. **The server-writer soak, 24 hours, logged without a gap.**   Run while the Mac harness is loaded but unused and the server is the selected writer.   Owner: the seat running the cutover, on the Mac and the server.
3. **The no-Node soak, 24 hours, after step 2.**   Must start after the server-writer soak ends, with the Mac Node harness absent.   Owner: same, then the owner signs it off.
4. **The Mac host inventory, by a Mac seat.**   Supplies the missing `inventory.mac` artifact for the placement bundle.   Owner: a Mac seat.
5. **The sixteen placement recipes, with Jay present for recipes 11, 12 and 13.**   Then `node scripts/check-placement-evidence.mjs <bundle>/placement-evidence.json` -> exit 0, and only then may a human assert `placement-evidence`.   Owner: BF-2559's seat plus Jay.
6. **Jay's Decision 1 ruling on Control.**   Then the implementation lands and the Muster disposition is recorded;   that is the `control-disposition` receipt.   Owner: Jay, then the implementing seat.
7. **The Linux closure run, on a network-isolated Linux host, with the real adapters.**   Produces `actual-source-runtime-result.json` and the two closure receipts, which `scripts/emit-linux-retention-receipt.mjs` turns into the `linux-retention` receipt;   the human then asserts `linux-server-preservation`.   Owner: the Linux/server seat with an isolated runner.
8. **Archive and import parity, against the live store, with the owner's approval.**   `scripts/archive-node-store.mjs archive`, then `restore` into a scratch root, then `receipt --parity-report <import-parity.json>`;   the parity report comes from the Swift `StoreImportParityProbe`.   Owner: Mac seat plus owner approval for the live-store read.
9. **Replay parity on a Mac with Xcode.**   `swift run --package-path ios EngineReplayParityProbe` then `scripts/emit-replay-receipt.mjs`;   then assert `replay-parity`.   Owner: a Mac seat.
10. **Signed release and the installed previous-build update.**   `signed-release` needs codesign, notarization, staple, one installed native copy, the Open on Mac target, the companion without Electron, and a previous build updated through the native feed.   The release decision and the installed-update acceptance are the owner's (BF-2628 sits at that line).   Owner: the owner.
11. **The change plan receipt.**   The exact jobs, files and app copies to change, the deletion diff, the before/after plan, the routine and webhook disposition and the precise rollback.   Author: this seat, once steps 3 through 8 have fixed the shape of the deletion.
12. **The seven-day daily-driver observation.**   A separate seven-day receipt of signed native daily use, an iOS session, Open on Mac and the process inventory.   Owner: the owner's sign-off.
13. **Owner acceptance.**   An explicit external assertion approving this candidate's Mac-local Node source deletion, dated after every receipt it accepts.   The collector refuses to synthesize it.
14. **Refresh, collect, and run the final CLI.**   `decommission-gate-state.mjs` -> `collect-decommission-evidence.mjs` -> `check-decommission-gates.mjs`;   green means the packet is internally consistent, not that deletion is authorized.
15. **Then and only then the deletion,** in the runbook's order, and BF-2515 closes with the deletion commit, the soak dates and the archive location.

The calendar floor is set by steps 2, 3 and 12: 24 hours, then a later 24 hours, then 7 days.   If those run sequentially from the day BF-2514's server-writer soak begins, the earliest an owner-acceptance receipt could exist is about 8 days out.   Everything else in the list can run in parallel with the soaks except steps 10 through 12, which need a signed release.

## 4. Broken Things Found And Not Fixed

**1. The state refresh names a retired Linear CLI.**   `scripts/decommission-gate-state.mjs:72-90` (`resolveBoardCli`) prefers `~/.local/bin/board` and otherwise resolves `board` from PATH.   AGENTS.md records `~/.local/bin/board`, `board-legacy` and the mac-collab backend as retired write routes, and `simple-board` as the current CLI.   Measured: `node scripts/decommission-gate-state.mjs --out <state.json>` -> **exit 1**, nothing written, "Linear CLI 'board' not found on PATH or at ~/.local/bin/board. Set BOARD_CLI or install verified board at ~/.local/bin/board."   The script should prefer `simple-board`;   its `api query` argument surface is already compatible (`DOCUMENT`, `--max-chars`, `--json`), so the fix is the resolver, not the query.   On this host `simple-board` also fails closed for missing `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`, so the refresh additionally needs a credential grant.   Not fixed, per the audit brief.

**2. The collector's refusal message is wrong for an existing output directory.**   `scripts/collect-decommission-evidence.mjs:73` calls `mkdirSync(output, { mode: 0o700 })` with no `recursive` flag and no existence check, so `--out` on an existing directory throws `EEXIST`, which the generic handler at lines 82-84 reports as "Evidence collection refused: invalid, unredacted, mismatched, missing or unsafe capture".   Refusing an existing output directory is intended (`docs/verification/native-final-evidence.md:146`), but the message points a reader at the wrong cause.   Measured: **exit 2** with an existing `--out` directory, **exit 0** with a fresh one.   Not fixed, per the audit brief.

**3. Two test-environment couplings that are not product defects** (recorded because they will fail a seat that runs the suite here, and no code change is proposed):

- `scripts/decommission-gates.node-test.mjs:260`, `:267`, `:358` and `:435` spawn the ambient `node`, and the CLI under test imports `../shared/placement.ts`.   With the system node 22.22.1 on PATH: `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"`, and 2 tests fail.   With the CI runtime Node 26.13.1 first on PATH, the file passes 41 of 41.
- `deploy/linux-server/retained-fixture.mjs:52-56` requires the fixture root's mode to be exactly `0o700`, but `mkdirSync(root, { mode: 0o700 })` inherits the setgid bit from a group-shared parent.   `/mnt/fleet-extra/apps/scratch` is mode `2700`, so `scripts/emit-linux-retention-receipt.node-test.mjs` fails with "Fixture root must be an owned private real directory".   With `TMPDIR=/tmp` (not setgid) it passes 62 of 62.

No producer script was found to be logically broken.   All 10 decommission test files pass once the two environment couplings above are removed.

## 5. What I Ran, What I Could Not Run, What I Did Not Check

### Ran (lane `minimax-bf2515-gate-audit` at `ccd2a04c7`, Node 26.13.1, read-only)

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | lane workspace only |
| `node scripts/audit-node-decommission.mjs` | 0 | inventory clean, 1191 tracked files audited |
| `node scripts/check-placement-evidence.mjs docs/verification/placement-evidence.json` | 1 | 16 unasserted recipes, both inventories missing |
| `node scripts/decommission-gate-state.mjs --out <path>` (live Linear path) | 1 | no file written, retired-CLI error |
| `node scripts/decommission-gate-state.mjs --board-json <fixture> --out <path>` | 0 | wrote an honest state file: six issues Done, BF-2514 In Progress, `inventory-clean: true`, six human-only gates false, `macLocalHarness.present: true` |
| `node scripts/check-decommission-gates.mjs <state.json>` | 1 | blocked on BF-2514, six evidence keys, the Mac harness and the missing bundle |
| `node scripts/check-decommission-gates.mjs <state.json> --bundle <bundle.json> --source-sha ... --build ... --artifact-sha256 ...` | 1 | 13 `missing-receipt` blockers |
| `node scripts/collect-decommission-evidence.mjs <request.json>` (preview) | 0 | 13 missing receipts, `validation: not-performed` |
| same with `--out` on a fresh directory | 0 | wrote `bundle.json` and `state.json`, 0600 |
| same with `--out` on an existing directory | 2 | finding 2 above |
| `node scripts/check-decommission-tree.mjs` | 1 | "the tracked tree still carries the Node stack": `server/` 869 files, `companion/` 41 files, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| `node --test` over 10 decommission test files | 1 then 0 | 3 environment failures as described; 165 tests pass under Node 26 with `TMPDIR=/tmp` |

The state file and bundle used above are synthetic fixtures in a scratch directory.   They assert nothing, and they are not committed.

### Could not run, and why

- `ios/Scripts/EngineReplayParityProbe` and `ios/Scripts/StoreImportParityProbe` (Swift), and `swift test --package-path ios`: no Swift toolchain on this Linux host.
- `scripts/check-post-reboot-node.mjs` against a real Mac: needs macOS launchd, and the receipt producer refuses a verdict whose `platform` is not `darwin`.
- `scripts/archive-node-store.mjs archive` and `restore` against the owner's live store: out of scope by instruction.
- `deploy/linux-server/retained-actual-run.mjs --execute`: installs and starts a service, and `assertIsolatedNetwork()` refuses this host.
- `scripts/check-soak-24h.mjs`: needs the live Mac cutover window.
- The sixteen placement recipes: need a Mac and the server, and Jay present for recipes 11, 12 and 13.
- `scripts/placement-rollback-probe.mjs`: needs a named release directory and a selected runtime; no candidate was handed to it.

### Did not check

- The truth of any receipt, observation or owner assertion.   The tooling checks consistency and binding, not authenticity.
- The contents of the owner's live store, the live Mac process inventory, or `MAC-LOCAL-PROCESSES.md`.
- Whether the inventory documents' per-row Swift owners are correct.   The audit checks coverage by path, name and glob, not whether the named owner is the right one.
- The `signed-release`, `change-plan` and `daily-driver` receipts: no producer exists for them in the tree.
- Any other host's state, the Zulip record, or the fleet's own inventory of Macs.
