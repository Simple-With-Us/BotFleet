# The Phase 6 Decommission Runbook (BF-2515)

`docs/native-rewrite-port-inventory.md` says what replaces every Node file.  This runbook says in what order the Node stack comes out, what proves each step is safe, and what to do when a step is not safe yet.

Read the two together.  The inventory owns "who replaces what"; this file owns "when", and the failure modes that make "when" matter.

## The One Rule

**Nothing is deleted before `scripts/check-decommission-gates.mjs` exits 0.**

That is not a formality.  Deleting `server/`, `companion/` or the Node build chain does not degrade a feature, it stops every bot, and it does so at the next launch rather than at the moment of the commit.  A green gate is the difference between a cleanup and an outage.

## The Gate

```
node scripts/check-decommission-gates.mjs <state.json>
```

The state file is plain JSON, so the check itself needs no network:

```json
{
  "issues":   { "BF-2510": "In Progress", "BF-2514": "Todo" },
  "evidence": { "soak-24h-no-node": false, "inventory-clean": true }
}
```

Seven issues must be Done and four evidence items asserted:

| Gate | Why it blocks the deletion |
|---|---|
| BF-2510 | The iOS companion endpoint ruling decides whether a slim Node companion host survives.  Deleting first answers the question by accident. |
| BF-2511 | The chosen companion endpoint must be built, or paired phones strand at cutover. |
| BF-2512 | The Swift Zulip actor and Linear sync client replace `server/zulip/*` and the Linear write path. |
| BF-2513 | The Swift routines and webhooks scheduler replaces the Node scheduler that fires every routine. |
| BF-2503 | Replay fixtures must be captured from the `events/*.ndjson` tee before the tee stops, or engine parity becomes unprovable. |
| BF-2504 | The `EngineDriver` contract and core actors are the runtime every native engine turn runs on. |
| BF-2514 | The single-writer cutover retires `app.botfleet.server` and owns the 24-hour no-Node run.  Phase 6 owns only the reboot check after it. |

| Evidence | What must be true |
|---|---|
| `soak-24h-no-node` | 24 hours with the Node harness stopped and its launchd job booted out, every bot answering. |
| `replay-parity` | Each engine's recorded turns replay through `EngineDriver` with the same ordered `TurnEvent` kinds the Node harness recorded. |
| `final-import-parity` | The final import parity report matches, the Node store is archived read-only, and rollback has been rehearsed once. |
| `inventory-clean` | `scripts/audit-node-decommission.mjs` reports no file under `server/`, `companion/`, `shared/` or `electron/` without a Swift owner or a retired reason. |

Anything that is not a completed state counts as unmet, including `In Review`.  The gate exists to stop nearly-done from reading as done.

Refresh the state file from Linear at run time rather than editing it by hand.  A stale all-Done file is the one input that defeats the guard, so the CLI prints the age of the file it read:

```
board api query --max-chars 64000 \
  'query { issues(filter: { team: { key: { eq: "BF" } } }, first: 250) { nodes { identifier state { name } } } }' --json
```

`inventory-clean` is checked for you.  `pnpm test:native-release` runs `scripts/decommission-gates.node-test.mjs`, whose last test audits the committed tree against both inventory documents, so inventory drift fails CI on the pull request that caused it rather than surfacing during a rebase months later.

## Why The Order Is Not The Obvious Order

Three couplings invert the naive sequence, which would start by deleting Electron because Electron is the old shell.

**1. The Electron binary is the harness's Node runtime.**  `electron-builder.yml` sets `runAsNode: true` deliberately, and the harness launches the Electron binary with `ELECTRON_RUN_AS_NODE=1` from the ACP drivers, the container computer and the MCP lanes.  Remove `electron/` while `server/` is still the running harness and the next boot has no runtime at all.  The failure arrives at launch, not at the next cleanup.

**2. The transcript tee is the only source of replay fixtures.**  `server/thread-events.ts` writes the per-thread `events/*.ndjson` files, and BF-2503 captures fixtures from them.  Once that file retires, the corpus is gone and engine parity stops being unproven in practice and becomes unprovable in principle.

**3. Paired phones talk to the companion, not the harness.**  `companion/src/*` serves the device endpoint.  If the sidecar goes before BF-2511 builds the chosen endpoint, the Mac app keeps working and the phone quietly stops, which is the worst shape a regression can take.

So the sequence runs from the leaves inward: dev-only and already-superseded surfaces first, then the companion, then the harness, then the Electron shell that is currently hosting the harness's runtime, then the build chain that produced all of it.

## The Sequence

### Step 0 — Prove The Gate

```
node scripts/audit-node-decommission.mjs
node scripts/check-decommission-gates.mjs /tmp/phase6-state.json
```

Both must be green before anything else in this document.  If the gate blocks, stop here; the blockers name the issues to finish, and the rest of this runbook is not yet in scope.

**Verification:** `every audited file has an inventory row`, then `Phase 6 decommission gates: all green.`

### Step 1 — Archive Before Anything Moves

Do this while both stores still exist, because it is the only window in which they can be compared.

- Export the Node store with the importer and run the parity report (BF-2495).
- Copy every `events/*.ndjson` and `native/*.ndjson` corpus to the archive, and capture the BF-2503 fixtures from it.
- Record the read-only archive location in BF-2515 before the deletion commit, so the archive is discoverable after the code that wrote it is gone.
- Rehearse the rollback once: restore the archive into a scratch data root and boot the native app against it.

**What breaks if skipped:** a parity bug found after the deletion has no reference to compare against, and the Node store becomes the only copy of a history nobody can read.

### Step 2 — The Cutover Belongs To BF-2514, Not Here

`app.botfleet.server` is booted out, the native app becomes the single writer, and the 24-hour no-Node soak runs under BF-2514.  Phase 6 does not repeat that work and does not shorten it.

**Precondition:** BF-2514 Done, `soak-24h-no-node` asserted, and `app.botfleet.server` confirmed booted out with `launchctl print` showing no job.

**What breaks if skipped:** the harness is still the writer when the deletion lands, and the deletion is what discovers it.

### Step 3 — Dev-Only Surfaces

Safe in any order, and safe to do in one commit.  None of these has a production caller.

- `scripts/mcp-server.ts`, `scripts/mcp-sse.ts`, `scripts/start-mcp-sse.sh`, `server/mcp-server-config.ts`, `server/sse-*.ts` test helpers.
- `scripts/e2e-server.mjs`, `scripts/bundle-server.mjs`, `scripts/plugin-smoke.mjs` and the packaged-server smoke scripts, plus the `vite.config.ts` dev proxy.
- `server/testing/*` (28 fakes and harness files), superseded by `ReplayHarness` fixtures.
- `cloudflare/control-plane/` (a stub with no code left in it).
- The `e2e` and packaged-server CI jobs that exist only to drive those scripts.

**Verification:** `pnpm typecheck` and the surviving test suite still pass; no workflow references a deleted script.

### Step 4 — The Companion Sidecar

**Precondition:** BF-2510 Done and BF-2511 Done, and a paired phone has completed a full session against the native endpoint.

- `companion/` (17 source files, 19 test files), the ignored `dist-companion` build output, and `scripts/capture-companion-fixtures.mjs`.
- `scripts/botfleet-companion-start.sh`, `scripts/launchd/app.botfleet.companion.plist`, and the Electron-side supervisors `electron/managed-companion-*.mjs` and `electron/companion-*.mjs`.

**Verification:** pair a phone, send a turn, receive a reply, and confirm the app reports the phone as connected without any `:8810` listener owned by Node (`lsof -nP -iTCP -sTCP:LISTEN` shows nothing on that port).

**What breaks if skipped:** every paired phone strands silently, and the failure looks like a phone problem rather than a deletion.

### Step 5 — The Harness

This is the irreversible one, and it is the step the whole gate exists for.

**Precondition:** BF-2512, BF-2513, BF-2503 and BF-2504 all Done; `replay-parity` and `final-import-parity` asserted; the soak complete.

- `server/` in full, `tsconfig.server.json`, and the `dev:server` and `mcp` package scripts.
- The Node-only `shared/` shims (there are none today; `shared/` is clean and every file ports as a Swift value type).
- `scripts/launchd/app.botfleet.server.plist`, `scripts/botfleet-server-start.sh`, `scripts/botfleet-server-healthcheck.sh`, `scripts/launchd/harness-watchdog.node-test.mjs`.
- The Node CI jobs that build and test the harness.

**Verification:** a cold boot with no Node process anywhere (`pgrep -fl node` empty), every bot answering a turn, routines firing on schedule, Zulip and Linear round-tripping, and the reboot check from BF-2515 passing twice.

**What breaks if skipped:** the app has no runtime.  This is not a metaphor; `runAsNode` means the binary that would have run the harness is the one this step has not removed yet, and Step 6 removes it.

### Step 6 — The Electron Shell

**Precondition:** Step 5 complete, which is what makes this step legal rather than fatal.

- `electron/` (135 tracked files), `electron-builder.yml`, `package.json` `main`, `preload.cjs`.
- `.github/workflows/release.yml`, `mac-commit-build.yml`, `mac-package-gate.yml`, `mac-server-menu-smoke.yml`, and the electron-updater feed jobs.
- `src/` and the Vite build, since the native UI is in-process and no longer needs a packaged `ui` directory.

**Verification:** the native app builds, signs, notarizes and staples through `native-mac-release.yml`, and an installed previous build receives the Sparkle update.

**What breaks if skipped:** nothing, if Step 5 really is complete.  If Step 5 was skipped, this step is the one that makes the outage permanent.

### Step 7 — The Build Chain And The Repository It Left Behind

- Desktop `package.json` dependencies that exist only for Electron, Vite and the Node harness; `tsconfig.server.json` is already gone from Step 5.
- Node-specific CI: `node-ci.yml`, the `ubuntu-latest` matrix legs, and any job whose only subject was the harness.
- `scripts/update-botfleet*.sh`, `scripts/regenerate-*.mjs`, `scripts/stamp-commit-version.mjs`, and the Node updater scripts that BF-2486's Sparkle pipeline replaced.
- `scripts/computer-vm-cli/` thin shims, while `vm-image-build.yml` and the image itself stay.

**Verification:** CI is green with no Node job, and `git grep -l "ELECTRON_RUN_AS_NODE"` returns nothing.

### Step 8 — Post-Deletion Checks

- Cold boot on a clean data root, and again after a reboot.
- One full day of routines, Zulip traffic and a phone session.
- `node scripts/audit-node-decommission.mjs` reports zero tracked files under the four roots, which is the honest end state rather than a stale green.
- The gate script now reports all green with `inventory-clean` satisfied by an empty tree.
- BF-2515 closes with the deletion commit, the soak dates and the archive location.

## What Stays

The native app, `ios/`, `mac-control/` (already Swift), the VM image build, `apps/site`, `tools/`, `tv-face/`, and `cloudflare/composio-broker/` (self-hosted, no harness calls).  None of them is part of the decommission, and deleting any of them is a different issue.

## Rollback

Before Step 5, rollback is `git revert`.  After Step 5 there is no code rollback, only the archive from Step 1: restore the data root, check out the last pre-deletion commit, and boot the Node harness from it.  That path is why Step 1 rehearses it once, while it is still cheap to discover that the archive is incomplete.
