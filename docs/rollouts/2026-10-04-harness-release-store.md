# 2026-10-04 — An Immutable Release Store For The Always-On Harness

repo: BotFleet | [MM] Claim: board `f1482275` (Recommendation 2, harness half), branch
`minimax/harness-release-store`, PR #858, issue #891, board f1482275, seat MINIMAX, Mac.

**Coordination exception (historical, not retroactive compliance):** the first commits on this
lane landed before a `repo: BotFleet`-first `#agent-sync` post.  The board row was live first;
the Slack claim and this rollout header were written during review, and that ordering is stated
here rather than rewritten as if it had been compliant from minute zero.

**2026-10-06 [CURSOR] sync:** `repo: BotFleet` — clearing the remaining Kody review threads on
PR #858 (`minimax/harness-release-store`); no new scope beyond review fixes and verification.

Author: MINIMAX.

## Changes Made

### Context & Objective

The always-on harness LaunchAgent runs from a mutable linked deployment checkout
on the operator Mac.  Every update `git checkout --detach`s that worktree and renames a
fresh `node_modules` into place **under a live Node process that is serving HTTP
and holding SQLite writes**.  There is no rollback if the new tree is wrong: the
old one has already been renamed away.

Two failures follow from that shape, and both have happened on this Mac:

- An update renamed the dependency tree and then failed to start the server, so
  there was nothing to put back.
- The disk janitor removed `node_modules` from a running checkout, and the
  launcher's self-heal then spent its budget reinstalling dependencies
  *underneath a live server* — a repair performed against the directory that was
  serving traffic.

The same checkout is also a shared hazard: it has been reset to `origin/main`
by hand three times now because a different seat's branch deleted files it
still imported.  See board `66bc29ad`.

### What It Is

Each commit gets an immutable directory under the BotFleet release store
(`releases/<commit>` beneath the store root), prepared in `staging/<commit>` and
activated by moving one pointer at `current`.  Preparing a new version cannot damage the running
one, because it happens somewhere else entirely, and the previous release is
still on disk afterwards — so an unverified new version costs a rename rather
than an outage.

`scripts/harness-release-store.mjs` is the store: path layout, promotion, the
pointer swap, release listing, liveness, and retention.

### What It Deliberately Does Not Do

**It does not change how the desktop app updates.**  That path is
`electron-updater`'s, guarded by the critical Kody rule
`do-not-change-sparkle-feed-url`, and the auto-update contract is real here:
`electron-updater` is vendored at `electron/vendor/electron-updater.cjs`,
`electron/updater.mjs` drives the in-app updater, and
`.github/workflows/release.yml` publishes a live feed.  Retiring it on macOS in
favour of a single installation controller is the architecturally correct end
state, and it is also exactly the change that rule protects installed copies
from.  That is the owner's decision, not an agent's.

This work touches no update-feed surface and resolves none of the two-updater
ambiguity, because it involves neither updater.

**It does not activate anything on the operator Mac.**  The live harness start
script is unchanged and the LaunchAgent still runs from its deployment checkout.
Moving the LaunchAgent `WorkingDirectory` to the store's `current` pointer is a
separate on-demand operator step that pauses for the owner, with a rollout and a
verified rollback.

## Decisions & Trade-offs

The three decisions worth reviewing:

### The pointer swap is symlink-then-rename, not `ln -sfn`

BSD `ln` follows a symlink-to-directory when creating a new link unless `-h` is
also passed, so `ln -sfn target current` silently creates the link **inside the
release it was meant to replace**, and `current` keeps pointing at the old one.
`rename(2)` over an existing path is the same atomic operation with none of that
edge case.  A test pins the exact nesting failure so the idiom cannot creep back.

### `isHeld` judges on `lsof`'s output, never its exit status

`lsof`'s status reports whether it **warned**, not whether it found anything: a
run that prints a valid match still exits 1.  Judging on the status reads a held
tree as free, which for a deletion gate is exactly backwards.

The naive fix is worse.  Treating any non-zero as "cannot answer" makes every
release permanently unprunable, because `+D` routinely warns and so routinely
exits 1.  Three cases are therefore distinguished:

| Observation | Meaning |
|---|---|
| a `p<pid>` line in the output | held |
| empty output, numeric exit code | lsof ran and found nothing |
| no numeric code (`ENOENT`, killed, timed out) | could not run — not permission to delete |

Both failure directions are pinned by tests, including one that asserts a
non-zero exit alongside a real match.

### Retention ranks by `promotedAt`, not by commit name

A commit SHA contains no time information, and lexicographic order is
chronological only when commits happen to be created in ascending order — a
coincidence, not a property.  The first version of this sorted by name and its
comment claimed SHAs sort by time.  Promoting `bbbb…` and then `aaaa…` put
`aaaa…` first, so keeping the most recent N deleted the **newer** release and
retained the stale one — a rollback target that is not a rollback target.  The
new case promotes three releases in an order that defeats name-sorting, and
reverting the comparator makes it fail.

### The Launcher, And Why It Had To Change

`scripts/botfleet-server-start.sh` wrote its "a self-heal was tried recently"
stamp **inside `$ROOT`**, and ran `pnpm install --frozen-lockfile` inside
`$ROOT`.  Against a release — read-only by construction, and meant to stay
byte-identical to the commit it names — the stamp write fails, and the install
either errors with a permissions message that explains nothing or succeeds and
leaves a release matching nothing the updater verified.

A release is now detected by its `.botfleet-release.json` manifest and the
self-heal **refuses**, naming the commit and pointing at the updater that
promoted it.  In a mutable checkout the in-place repair is still the right answer
and still happens: a half-deleted `node_modules` is a recurring failure here and
the fast repair is worth keeping.

`$ROOT` is resolved with a physical `cd -P`.  `current` is a symlink, and a
launcher that keeps it would give the server the *pointer* as its working
directory — while `dependencyFingerprint` and `validateBuiltBundle` both refuse
a symlinked root, so the two halves would disagree about which directory they
were reasoning about.

The heal stamp's default moved to
`~/Library/Caches/BotFleet/server-start-heal-stamp`: it is mutable state, and
with one harness, one budget per machine is the honest accounting.

## Files Touched

- `scripts/harness-release-store.mjs` — path layout, promotion, pointer swap,
  listing, liveness, retention.
- `scripts/harness-release-store.node-test.mjs` — 17 cases against the real
  filesystem with a real `lsof`.
- `scripts/botfleet-server-start.sh` — physical root resolution, release-aware
  self-heal, stamp relocation.
- `scripts/botfleet-server-start.node-test.mjs` — 4 release cases appended to
  the 7 pre-existing launcher tests.
- `MAC-LOCAL-PROCESSES.md` (owner-local inventory) and the pinned **Background Jobs
  Master List** Apple Note — updated in the same change, both stating that the
  live helper is unchanged and the store is not activated.

## Verification

Commands run on 2026-10-06 (cloud seat, branch `minimax/harness-release-store`):

| Command | Result |
|---|---|
| `node --test scripts/harness-release-store.node-test.mjs` | pass (release-store cases below) |
| `node --test scripts/botfleet-server-start.node-test.mjs` | pass (11 launcher cases) |
| `pnpm exec oxlint scripts/harness-release-store.mjs scripts/harness-release-store.node-test.mjs scripts/botfleet-server-start.sh` | pass at existing baseline |
| `git fetch origin main && pnpm exec oxlint …` (same paths) vs `origin/main` | no new violations vs baseline |

Release-store coverage includes: a live process holding a file inside a tree, a real
cross-device rename injected to pin the `EXDEV` message, the pointer-nesting
failure, the non-atomic swap fallback driven by an injected `EPERM` (so the
Windows path is covered on every platform, not only on Windows), retention
ordering and mtime tie-breaks, manifest/directory identity guards, staging-missing
`ResolutionError`, and manifest rejection for a number, a branch name, a short SHA, a
trailing non-hex character, a missing commit, and unparseable JSON.

Launcher coverage runs the real script: a release with no `node_modules`
does not invoke pnpm — observed with a stub that records the call — and names
the commit and the alternative, while an ordinary checkout with the same fault
still reinstalls.  The seven pre-existing launcher tests pass unchanged,
including the restart-storm behaviour.

Two Windows-only failures were caught only by hosted CI after being green locally,
which is the point: neither the code nor a Mac-only run would have found them.

## Follow-ups

1. Add `scripts/harness-release-store.mjs` to the updater's bootstrap archive
   list in `scripts/update-botfleet.sh`, and stage/promote/swap in the install
   path.  Until then the store is not reachable from `ubf`.
2. Point the LaunchAgent `WorkingDirectory` at the store `current` pointer, with the
   updater resolving it physically for fingerprinting.  **This pauses for the
   owner**: it relocates an always-on process.
3. Add the strict release-manifest schema Kody asked for.  The reason it is not
   here is that this module is about to join the updater's bootstrap archive,
   which has no `node_modules` beside it, so a bare third-party import would work
   in CI and then break `ubf` on every Mac.  Once the archive entry exists that
   constraint is gone and the schema is free.

## Zero-Code Findings

- The repo has no tracked copy of the always-on harness LaunchAgent plist;
  only the start script is tracked.  A launchd entry that governs an always-on
  process, with no template in version control, is a gap worth closing before
  the `WorkingDirectory` move.
- `docs/EFFORT-LOG.md` was truncated from 716 rows to 9 on `main` during this
  work, by a one-character mistake in an append helper.  See board
  `a90e1f15` and PRs #846 and #850.  Two of the three rebases this branch needed
  afterwards were conflict-free only because `merge=union` was added.
- **Fleet recall (2026-10-06):** searched `harness release store immutable pointer prune lsof`
  before closeout; closest hit was board `f1482275` (isHeld output-vs-exit semantics).  **New
  lesson contributed:** release identity for prune/retention must be the `releases/<commit>`
  directory name; a manifest whose `commit` field disagrees with that name must not redefine
  `currentCommit` or enter `listReleases`, or the live tree becomes a prune candidate.
