# 2026-10-04 — Updater Architecture: CI-Built Artifacts, A Pre-Activation Smoke Gate, And Decoupled Installs

Board rows `34c834f1` (Rec 1), `49465fcb` (Rec 4), `1f3fe835` (Rec 3), `f1482275` (Rec 2).
Branch `minimax/updater-architecture`, then `minimax/updater-decouple`.  Worktree
the MINIMAX seat worktree.

Owner approved all four recommendations from an architecture review that
reverse-engineered how `mcode` swapped 0.5.5 to 0.6.2 in seven seconds with
running sessions untouched: download a prebuilt artifact instead of compiling,
keep immutable versioned release directories, never mutate a live checkout,
swap a pointer atomically, and smoke-test a staged artifact before anything live
is touched.

## What Ships

### 1. A Pre-Activation Smoke Test Of The Candidate

Every check the updater ran before installing was a **file** check: signed by the
expected team, carrying the expected bundle identifier, stamped with the expected
commit.  All read from bytes; none proved the artifact runs.  0.1.24 passed every
one of them and died on every launch with `ERR_MODULE_NOT_FOUND: Cannot find
package 'zod'`, because `tsc` leaves bare imports verbatim and the packaged tree
carries no `node_modules`.

`scripts/smoke-packaged-server.mjs` has caught that class of bug in CI since, but
only for artifacts GitHub built.  A candidate that was downloaded from a build,
imported from an existing stage, or produced by a local fallback had no equivalent
gate on the Mac that installs it — so the first thing that could notice a dead
candidate was *after* the harness had already been quiesced and fenced.

`prepareUpdate` gains a `smokeTestBundle` step between `validateBundle` and
`persistPrepared` — the last point in the transaction that still touches nothing
live: no prior-state capture, no candidate copy, no service restart, no bundle
rename.  A failure there costs a staging directory instead of a rollback.

The probe copies `Contents/Resources/server` out of the bundle and runs it on the
**packaged Electron binary** under `ELECTRON_RUN_AS_NODE=1` — the runtime the
harness actually uses, and the reason `electron-builder.yml` keeps the `runAsNode`
fuse on.  It waits for a **validated** `/api/health` body (a boolean `ready` and a
string `app`), requires the owner record to name the probe's own pid, then
round-trips a row through `DatabaseSync` from `node:sqlite` on `:memory:`.  The
`node:sqlite` check is the direct analogue of MCode initializing `better-sqlite3`
in memory: the store opens its database through it (`server/message-db.ts`), a
native binding that must load before the harness can run at all.

**A timeout is never reported as a corrupt artifact.**  The Sep 17 and Oct 1
outages were both *a healthy binary plus a starved CPU* at load 400–700, and every
tolerance widened so far was inside a step that should not have been running on
that machine at all.  So `classifySmokeFailure` keeps "too busy" and "broken"
apart, exactly one readiness timeout is retried and nothing else, and the timeout
message tells the operator to re-run when the machine is quieter.

### 2. Commit-Keyed Builds On GitHub Runners, Installed By Commit

The Mac that installs updates used to build them.  `pnpm package:mac:local` is a
10–15 minute `electron-builder` run on the same Mac running five to ten agent
seats, and every recorded update failure was inside it.  Owner ruling 2026-10-01:
GitHub's Mac runners do the building, always, with a local bypass.

`.github/workflows/mac-commit-build.yml` runs on every push to `main` and on
demand, publishing a signed arm64 `BotFleet.app` keyed by its commit.  It is
deliberately **not** `release.yml` with a different trigger: that pipeline builds
both architectures, notarizes, staples and publishes a version-keyed feed because
its job is distribution, while this artifact is installed by `ubf` on the owner's
own machine.  It keeps the real Developer ID certificate from Infisical, a
signature gate before publishing, the exact team id, and
`scripts/smoke-packaged-server.mjs`.

`buildBundle` now tries the hosted build first and only falls back to
`pnpm package:mac:local` when `BOTFLEET_UPDATE_SOURCE` says so.  Default is `ci`
— a default of `local` would make the ruling opt-in and quietly restore the slow
path.  `scripts/ci-build-resolver.mjs` resolves the exact commit through the
Actions API, accepts only a successful run of this workflow for this SHA, ignores
an expired artifact, verifies the manifest's commit and sha256, and then hands the
unpacked `.app` to the existing `validateBuiltBundle`, which still demands the exact
Developer ID team and designated requirement.  **The signature is the security
boundary; the manifest only guards the transfer.**  A manifest naming a different
commit is refused even though its bytes would pass a signature check, because that
signature is perfectly valid for another build.

### 3. `--components` Decouples A Server Update From The UI Relaunch

Updating the harness also quit and reinstalled the desktop app, and vice versa.
The coupling was never one step — it was spread across six, each individually
reasonable.  `--components both|server|app` (or `--server-only`) states which
halves a run owns, defaulting to `both` which is exactly today's behaviour.  A
server-only run stops the harness, swaps the dependency tree, restarts it, and
proves it is the single authenticated data owner, without quitting the app,
renaming its bundle, preparing its credentials, reopening it, or sampling its
processes.

The app is a **client** of the harness, verified rather than assumed:
`electron/main.mjs`'s attach-or-spawn leaves the window talking to the always-on
`app.botfleet.server`, which is never killed on quit.  So against the always-on
harness a server-only update is clean.  The usage text carries the honest caveat:
on a desktop with no always-on harness, where the app spawned its own, that child
lives until the app is next restarted.

## Decisions & Trade-offs

**The two zod suggestions were answered, not implemented.**  The updater
bootstraps itself by archiving a small fixed graph into a `mktemp` directory with
**no `node_modules` beside it**, then running it; every module in that graph
imports nothing but `node:` builtins, deliberately.  A bare `import { z } from
"zod"` would resolve in the repo and throw `ERR_MODULE_NOT_FOUND` on every Mac at
the moment it is trying to recover from a failed update.  The intent of the rule —
never read a field off an untrusted response without checking its shape — is met
by explicit shape checks, with the reason recorded beside them.

**The stage-entry allowlist is now defined once.**  `KNOWN_STAGE_ENTRIES` existed
in both `scripts/update-botfleet-mac.mjs` and `server/update-control.ts`, each
carrying a comment claiming parity with the other.  They drifted, and only the
server's copy decides what the harness prunes, so every stage the default `ci`
policy produced was kept forever with a full extra copy of the app and a
multi-gigabyte dependency tree inside it.  It now lives in
`scripts/stage-entries.mjs`, imported by both, with a test that fails if either
file redeclares it.

**`scripts/*.sh` stays ASCII-only**, per the standing rule that Apple bash 3.2.57
mis-parses a non-ASCII byte adjacent to a `$VAR`.

**Rec 2 is deliberately scoped to the harness.**  See Next Steps.

## Files Touched

- `.github/workflows/mac-commit-build.yml`: New — per-commit signed arm64 build, commit-keyed artifact, `concurrency` cancelling superseded builds.
- `docs/verification/staged-candidate-smoke.md`: New — the probe's contract, why a timeout is not a broken build, and the recipe that runs it against the real installed bundle.
- `docs/verification/README.md`: Index entry for the recipe.
- `scripts/ci-build-resolver.mjs`: New — policy (`ci`/`auto`/`local`), run and artifact selection, manifest verification, `ditto` unpack.
- `scripts/ci-build-resolver.node-test.mjs`: New — 13 cases: policy default, cause classification, expired artifacts, manifest commit/sha256, traversal names, malformed API entries, fatal-retry contract, `build-failed` classification, real two-level unpack.
- `scripts/stage-entries.mjs` / `.d.mts`: New — the single stage-entry allowlist plus types for the server import.
- `scripts/update-botfleet-arch.node-test.mjs`: New — enforces the bootstrap archive list in both directions and the single allowlist definition.
- `scripts/mac-update-transaction.d.mts`: New — declarations so the step-label coverage test can import the coordinator's step lists.
- `scripts/mac-update-transaction.mjs`: `smokeTestBundle` step; exported `PREPARE_STEPS` / `APPLY_STEPS`.
- `scripts/update-botfleet-mac.mjs`: The probe, the CI-backed `buildBundle`, `swapDependencyTree`, `--components`, the shared allowlist import.
- `scripts/update-progress.mjs`: `UPDATE_STEPS` gained `smokeTestBundle` so the progress fraction advances during the longest step.
- `scripts/update-botfleet.sh`: Archive list gained `ci-build-resolver.mjs` and `stage-entries.mjs`.
- `server/update-control.ts`: `smokeTestBundle` label; imports the shared allowlist and deletes its two local copies.
- `docs/EFFORT-LOG.md`: Rows for each unit.

## Verification

- `pnpm test:mac-updater` — 144 pass, including the archive guard and the
  component-selection cases.
- `node --test scripts/ci-build-resolver.node-test.mjs` — 13 pass.
- `npx vitest run scripts/update-progress.test.mjs server/update-control.test.ts` — 78 pass.
- `pnpm typecheck` — clean.
- **The probe against the real installed signed bundle** `d9e646ffc292` on the
  owner's Mac: `ready: true`, `sqliteOk: true`, **17.6s quiet and 51.4s while four
  other seats were compiling** — the measured reason the boot budget is 180s.  The
  the live harness stayed ready throughout, with no scratch left behind and no
  stray processes.  Recipe in `docs/verification/staged-candidate-smoke.md`.
- **Mutation-checked**, because a green test proves nothing until the fix is
  removed and it goes red: removing the `smokeTestBundle` label fails the update
  card's coverage guard with the step named; adding an import of
  `scripts/ci-build-resolver.mjs` without adding it to the archive list fails the
  archive guard with the missing path named.

Hosted CI is the authoritative gate for `pnpm typecheck && pnpm test`.  Two
findings it caught that local runs did not: a second, independent coordinator
fixture in `update-progress.test.mjs` that the new step silently invalidated, and
a `TS7016` from the server test importing the plain-JS coordinator without
declarations.

## Next Steps & Blockers

**Rec 2 (board `f1482275`) is deliberately scoped to the harness**, and the
reason is a critical standing rule rather than a preference.  The Kody rule
`do-not-change-sparkle-feed-url-dcf0e5b2` guards the auto-update contract, and
that contract is real here: `electron-updater` is vendored at
`electron/vendor/electron-updater.cjs`, `electron/updater.mjs` drives the in-app
updater, and `.github/workflows/release.yml` publishes a real feed to
`jaywedgeworth22/BotFleet`.  (The rule's own file paths — `docs/AUTO-UPDATE.md`,
`script/build_and_run.sh`, `.github/workflows/mac-release.yml` — do not exist in
this repository, so the rule text is generic, but its substance is accurate and a
critical-severity guard is not something to route around.)

Retiring that path on macOS in favour of "one installation controller" is the
architecturally correct end state, and it is also exactly the change that rule
protects installed copies from.  It needs the owner's explicit call, not an
agent's.  So Rec 2 proceeds on the half that touches no update-feed surface at
all: a versioned release directory per commit for the always-on harness,
a staging directory for preparation, `current` swapped with `ln -sfn`,
and the service definition's working directory pointed at `current`.  That is where the
real pain is — the harness currently runs from a mutable linked worktree and
`git checkout`s and swaps `node_modules` under a live Node process serving HTTP
and SQLite writes (board `66bc29ad`) — and it resolves none of the ambiguity
between two updaters because it does not involve either one.

Migrating the live LaunchAgent is an on-demand operator step with a verified
rollback, not something a pull request applies silently.  Three things must move
with it.  The launcher cannot write its heal stamp into the server's own tree,
and cannot reinstall dependencies there either, because a promoted release is
read-only and must stay byte-identical to the commit it names — so its
self-heal has to detect a release and refuse rather than repair one in place.
And because `dependencyFingerprint` and `validateBuiltBundle` both reject a
symlinked root, the activation pointer can only be a launchd-level
indirection, with anything that reasons about the tree resolving it physically
first.

## Zero-Code Findings

- The updater's bootstrap archive is a **literal list of files in a shell
  function**, and nothing in the JavaScript noticed a new local import.  The only
  warning was a comment.  Any future refactor that reaches for a new module
  would break `ubf` on every Mac at the moment it is trying to recover from a
  failed update.  Now enforced in both directions.
- `scripts/update-progress.mjs` has a **second** step list, separate from
  `PREPARE_STEPS`.  Adding a step to one and not the other does not throw — it
  silently freezes the progress fraction on the Mac and the phone during that
  step.  Both lists are now asserted in step with a third check on the update
  card's labels, so a new step fails in three places that each name what is
  wrong.
- Two of the four load-bearing invariants in this path were **duplicated with a
  comment asserting they were in sync**, which is how a comment keeps a fact from
  being checked.  One of those duplicates was leaking disk on every update.
