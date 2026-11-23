# The Electron No-Delete Map

Status:  inventory only (`Refs BF-2485`, `Refs BF-2498`).  Nothing was deleted,
moved, installed, archived or retired, and this map does not propose any of
those.  Every row is a classification of a file that is in the tree today.

## What This Map Is For

The decommission plan has an order in it, and the order is the whole point:
BF-2515's Step 5 comes before BF-2485's Step 6, because Electron is still
the harness runtime.  Deleting the Electron stack before the server runs its
own runtime removes the Node binary the harness boots.

That makes a map of what may not be deleted yet more useful than a list of
what may.  This is that map.  Each piece of the Electron stack lands in
exactly one class, and the class says what has to be true before it can
move.

The classes:

- **REMOVABLE-AT-STEP-6** — Mac legacy shell.  Nothing outside `electron/`
  and the Electron packaging imports it, so it goes when the shell does.
- **RETAINED-SERVER-OR-WORKER** — something the Node harness, the companion
  sidecar, the Linux server service, a Cloudflare worker, a CI job or a
  deploy script still needs.  It stays.
- **DEPENDS-ON-BF-2688** — the BotFleet Control product controls and their
  build and bundle path.  They have to move into the native Mac app and
  carry the `control-disposition` receipt before Electron can be retired.
- **SHARED-SEQUENCE** — owned by another row, where the order matters more
  than the classification.
- **UNVERIFIED** — something this map could not establish from the tree.

## Method

Every count and every edge below comes from the tree at `a57ac6733`, and the
commands are given so each number can be recomputed:

```sh
# The Electron surface, and how it is grouped.
git ls-files electron/ | wc -l

# Which files outside electron/ import an Electron file.  The check is by
# file name, because that is how the tree imports them.
for f in $(git ls-files electron/ | grep -vE '\.(test|spec)\.' | grep -E '\.(mjs|cjs|mts|js)$'); do
  base=$(basename "$f")
  git grep -l -F "$base" -- server companion shared cloudflare scripts deploy mac-control src \
    | grep -v '^electron/'
done

# The Node runtime the harness still boots through.
git grep -n "ELECTRON_RUN_AS_NODE" -- server companion shared scripts deploy electron mac-control

# The dependency entries and the packaging entry point.
python3 -c "import json; p=json.load(open('package.json')); print(p['main']); print({k:  v for k, v in p['dependencies'].items() if 'electron' in k}); print({k:  v for k, v in p['devDependencies'].items() if 'electron' in k})"

# The two audits that read this tree.
node scripts/audit-node-decommission.mjs
node scripts/check-decommission-tree.mjs
```

The audit run on this tree reports `exit 0` over the tracked files under
`server/`, `companion/`, `shared/`, `electron/`, `deploy/` and `scripts/`.
The tree check reports `exit 1` with the tree it still carries, which is the
expected answer while the shell exists.

## The Delta From The Earlier Inventories

The inventory this map builds on is `docs/native-rewrite-electron-inventory.md`
(#2115), and the readiness checklist Muse Code filed on Nov 4.  Two things
moved since, and both are visible in the tree rather than in a comment:

- **The Electron surface is 136 tracked files.**  The Nov 4 checklist counted
  133 and 99 non-test files.  The gap is the native helper relocation
  (#1531) and the files that came with it.
- **The Linux closure now carries eight `electron/` files**, and it is the
  only consumer of most of them:  `app-paths.mjs`, `config-file-lock.mjs`,
  `credential-restore.mjs`, `harness-ownership.mjs`, `infisical-read.mjs`,
  `persist-on-exit-policy.mjs`, `runtime-identity.mjs` and
  `workspace-credentials.mjs`.  The `electron/` directory is not
  "the desktop shell" as a whole:  it also holds the Node runtime's
  configuration, credential and ownership helpers, and the Linux server runs
  them today.

That second point is the one that changes the shape of the decommission, and
it is why the classes below are per file rather than per directory.

## REMOVABLE-AT-STEP-6

These are the Mac legacy shell pieces.  Nothing outside `electron/` and the
Electron packaging imports them, so they leave with the shell and not before.

| Piece | Notes |
| --- | --- |
| `electron/main.mjs`, `electron/preload.cjs`, `electron/renderer-trust.mjs`, `electron/window-state.cjs`, `electron/window-chrome.mjs`, `electron/capabilities.cjs`, `electron/app-info.cjs` | the shell itself:  main process, preload, renderer trust, window state and chrome, capability surface |
| `electron/desktop-viewer.cjs`, `electron/desktop-workspace.cjs` | the Electron desktop viewer and workspace, with the native replacements already shipped (BF-2481, BF-2539) |
| `electron/cua-connection.cjs`, `electron/cua-linux.cjs`, `electron/cua-linux-runtime.cjs`, `electron/cua-linux-bundle.cjs`, `electron/cua-permissions-status.mjs`, `electron/screen-preview.cjs` | the Electron CUA path; the native driver and capture live in `ios/Sources/CompanionCore` |
| `electron/android-device.mjs`, `electron/control-plane-client.mjs`, `electron/companion.mjs`, `electron/companion-entry.mjs`, `electron/companion-origin-gateway.mjs` | the Electron companion client, its entry point and its origin gateway; the native listener is the replacement |
| `electron/managed-composio.mjs`, `electron/external-url.mjs`, `electron/open-file.mjs`, `electron/save-file.mjs`, `electron/package-link.mjs` | Electron-side helpers with no consumer outside `electron/` |
| `electron/remote-credential-guard.mjs`, `electron/secure-credentials.mjs`, `electron/secure-credential-state.mjs`, `electron/credential-patch.node-test.mjs` | the Electron credential store; the native path is BF-2506 and BF-2622 |
| `electron/speech.mjs`, `electron/skill-recorder.mjs`, `electron/assemblyai.mjs`, `electron/build-speech-helper.mjs`, `electron/build-recorder-helper.mjs` | the Electron voice helpers and the two build helpers that produce the native helper bundles |
| The Electron half of the packaging:  `electron-builder.yml`, the `electron` entries in `package.json`, `electron-updater`, `electron-builder` and `esbuild` in `devDependencies`, `@sentry/electron` in `dependencies` | the packaging and the Electron runtime |
| The Electron half of the release workflows | `release.yml` and `mac-commit-build.yml` build the Electron shell; `native-mac-release.yml` builds the native one.  The Electron halves go at Step 6; the shared jobs stay |

**The gate.**  Step 6 needs BF-2514's Step 5 done, BF-2486's replacement
pipeline live, and one installed build already updated through the Sparkle
feed.  The runbook's own precondition is that no Electron file is deleted
before `scripts/check-decommission-gates.mjs` exits 0.

## RETAINED-SERVER-OR-WORKER

These are live today, and each is marked with what keeps it alive.

**The Node harness's own runtime and helpers.  ACTIVE.**

- `electron/runtime-identity.mjs` — the harness answers which build it is,
  and the Linux server service runs it.  Retained by the server.
- `electron/harness-ownership.mjs` — the harness's ownership proof.
- `electron/credential-restore.mjs`, `electron/workspace-credentials.mjs` —
  the harness's credential restore and the workspace credential file.
  `workspace-credentials.mjs` is retained only while the server runs:  its
  Step 6 removal is a shared-sequence item with the root manifest, and
  it is deliberately not in the REMOVABLE-AT-STEP-6 table above.
- `electron/config-file-lock.mjs`, `electron/persist-on-exit-policy.mjs`,
  `electron/app-paths.mjs` — the harness's configuration and data paths.
- `electron/infisical-read.mjs` — the scoped Infisical read that the owner
  gate, the Linux harness and the bridge all use.  Retained by the server.

**The Electron binary as the Node runtime.  ACTIVE.**

`ELECTRON_RUN_AS_NODE=1` is read in `server/index.ts`, the engine drivers,
`scripts/update-botfleet-mac.mjs`, `scripts/smoke-runtime-mode.mjs`,
`scripts/smoke-packaged-server.mjs` and `scripts/check-post-reboot-node.mjs`.
The Electron binary is the Node the harness boots as.  Deleting the Electron
stack before the server runs its own runtime removes the Node binary the
harness starts with, which is why this is Step 5's work and not Step 6's.

**The Linux server service.  ACTIVE.**

`deploy/linux-server/` installs `botfleet-server.service`, which runs
`node server/index.ts` behind `botfleet-owner-gate.service`, and the retained
closure carries the eight `electron/` helpers above.  The service is the
server-owned placement's controller, and it is the thing BF-2515's Step 5
moves.

**The companion sidecar.  ACTIVE.**

`electron/managed-companion-runtime.mjs`,
`electron/managed-companion-supervisor.mjs`,
`electron/managed-companion-guardian.mjs` and
`electron/managed-companion-tunnel.mjs` are started by
`scripts/botfleet-companion-start.sh`, which is the launchd path the Mac app
uses today.  The native listener (BF-2590, BF-2690) is the replacement, and
the Node `:8810` sidecar retires only after the real-phone end-to-end run
in BF-2652.

**The packaged-server and runtime-mode gates.  ACTIVE.**

`scripts/smoke-packaged-server.mjs` and `scripts/smoke-runtime-mode.mjs` boot
the packaged Electron binary under `ELECTRON_RUN_AS_NODE=1` and fail when the
runtime is not the packaged one.  They are the CI proof that the harness runs
on the packaged binary, so they stay until the server runs its own runtime.

**The CI and deploy scripts that name Electron files.  ACTIVE.**

`scripts/bundle-server.mjs`, `scripts/mac-package-gate.mjs`,
`scripts/verify-packaged-versions.mjs`, `scripts/verify-linux-package.mjs`,
`scripts/prepare-cua.mjs`, `scripts/cua-linux-release.mjs`,
`scripts/native-version-probe.mjs`, `scripts/prepare-cloudflared.mjs`,
`scripts/placement-rollback-probe.mjs`, `scripts/source-build-identity.mjs`,
`scripts/update-botfleet-mac.mjs` and `scripts/update-botfleet-policy.sh` all
name Electron files.  They are build and release inputs, not shell pieces,
so they stay.

**The audit and the tree gate.  ACTIVE.**

`scripts/audit-node-decommission.mjs` is the inventory guard BF-2485's own
plan relies on, and `scripts/check-decommission-tree.mjs` is the gate that
still reports the Node stack.  Both stay until the tree gate passes.

**The Cloudflare workers.  ACTIVE, and outside this row.**

`cloudflare/composio-broker` and `cloudflare/control-plane` are separate
deployments that share the repository but not the Electron runtime.  Nothing
in them imports `electron/`, so this row does not touch them; they are named
here because the tree shares a repository and a reader should not assume
"the repository" means "the shell".

## DEPENDS-ON-BF-2688

BotFleet Control is the last product surface that still lives in the Electron
shell, and it is the reason the Electron bundle path cannot simply be
deleted.

- `mac-control/Sources/BotFleetControlCore/` — the Swift control core
  itself:  the control API, the build identity, the update handoff and the
  fleet services list.
- `electron/build-control-app.mjs` — the build script that produces
  `BotFleet Control.app`.
- `electron/server-controls.mjs` — installs `BotFleet Control.app` into
  `~/Applications` with an identity check and a symlink-safe copy.
- `electron/control-build-version.mjs` — the control build's version
  handshake.
- `electron-builder.yml` — the bundle path that ships both the control app
  and the helpers.

**What Option C moves.**  Jay's Oct 29 split, recorded in
`docs/plans/2026-10-29-botfleet-control-after-node.md` line 87:  the native
`BotFleetMac` owns the product lifecycle, startup and login-item controls,
the local VM controls, the saved-server controls and the fenced server
start and stop.  Muster owns fleet administration:  the fleet services list,
the pm2 rows, the process and port monitor, and the remote VM providers.
Linux stays optional.

**Why Electron cannot be retired first.**  The `control-disposition` receipt
needs three checks, and none of them can be produced while the control app
is built and installed by the Electron bundle path:

- `owner-decision` — the recorded Oct 29 split, which exists.
- `landed-implementation` — the native app carrying those controls, which is
  BF-2688's work and has not landed.
- `muster-disposition` — the recorded disposition of the fleet-admin half,
  which is a human attestation.

The BF-2515 gate audit calls the decision unruled.  That wording is stale:
the decision is recorded, and the open items are the implementation and the
Muster disposition, not another ruling.

## SHARED-SEQUENCE

Owned by another row, where the order matters more than the class.

| Item | Owner | Why the order matters |
| --- | --- | --- |
| `server/`, `companion/`, the Node build chain | BF-2515 | Step 5 comes first, because the server is the runtime Electron retires |
| The root `package.json` | BF-2515 and BF-2485 together | BF-2515 removes the desktop manifest, BF-2485 removes `main`, `dev:desktop` and the Electron dependencies at Step 6 |
| `shared/` | shared | the server keeps it; the Electron shell shares it |
| `deploy/linux-server/retained-source.json` | BF-2633 | the Linux closure carries the eight `electron/` helpers, so changing them changes the closure and the retention receipt |
| `docs/native-rewrite-electron-inventory.md` | BF-2485 and BF-2498 | this map is its companion, not its replacement |
| The release workflows | BF-2486 and BF-2485 | the native pipeline is BF-2486's; the Electron halves are BF-2485's Step 6 |

## UNVERIFIED

- **Whether the owner wants the Electron shell retired at all on macOS.**  The
  plan's Option A is macOS-only, and the Electron targets for Windows and
  Linux are still built by `release.yml`.  The owner's decision on those is
  not recorded in the tree, and this map does not assume one.
- **The exact set of `electron/` files the Electron packaging copies into the
  bundle.**  `electron-builder.yml` names `electron/**` as `files`, and the
  helper bundles come from `native/helpers/`, so the packaged set is
  "everything under `electron/`" plus the two helper apps.  A file-by-file
  list of what a packaged build actually contains was not produced here.
- **Whether the Mac's installed copy is the Electron one.**  The inventory
  records the Electron app in `~/Applications` and Login Items, and the
  rollback archive is the next step, but the installed state of a specific
  Mac is not something this tree can see.

## What This Map Does Not Authorize

It authorizes no deletion, no archival, no move, no install, no rebuild, no
signing run, no release, no route publication and no service change.  It
classifies what is in the tree and names the gate each class waits behind.
Nothing in it changes a live host.
