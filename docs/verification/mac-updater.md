# Mac updater transaction

The Mac updater fixture simulates signed update delivery, application, and transaction rollback using the updater's test harness without modifying the user's installed app.

## Setup

```sh
node scripts/mac-update-transaction.node-test.mjs
```

This test:

1. Stages a signed update package (DMG or ZIP)
2. Simulates the updater CLI parsing the feed
3. Verifies signature and notarization
4. Applies the update in a temporary directory
5. Rolls back on error and confirms no partial state remains

## Steps

```sh
# 1. Run the updater transaction test
node scripts/mac-update-transaction.node-test.mjs

# 2. Expected output:
# - "Verifying signature…" with success
# - "Applying update…" with staging directory
# - "Transaction committed" on success
# - Clean rollback on simulated error
```

## Expected Evidence

A passing run shows:

- **Output:** Transaction log showing each phase (verify, apply, commit)
- **No partial state:** Rollback removes all temporary files on error
- **Signature verification:** The updater confirms the package was signed by the expected developer identity
- **Version jump:** Update correctly advances from v1.0.30 to v1.0.31 (or configured versions)

## Key Behaviors Verified

- **Signature validation:** The update package is signed with the Developer ID certificate
- **Notarization check:** Stapled notarization ticket is validated
- **Atomic apply:** Update is staged in a temporary directory before final commit
- **Rollback on error:** Any failure during apply rolls back completely; no partial state remains
- **User experience:** User sees "Check for updates" progress and update-applied confirmation

## Important Notes

Creating or publishing a release, then checking, downloading, verifying, and installing it on a real device remain owner-only actions.  This test verifies the updater's transaction logic in isolation; end-to-end installation is tested separately on approved devices.

## Cleanup

The test removes its staging directories.  No manual cleanup is needed.

## Resources Guard, Recovery Clear, Status And Recover

These checks run in an isolated fixture.  They do not touch `/Applications/BotFleet.app` or a live harness.

```sh
node --test --test-name-pattern "Resources tree|pending-recovery markers|status reports|recover restores|ubf status prints" scripts/update-botfleet-mac.node-test.mjs
```

A passing run shows a dirty Resources tree refused until `--force` writes a backup, pending-recovery markers removed only after `live-ok`, `ubf status` printing the fixture, and `ubf recover` restoring once and then reporting that the install already matches.

## Release-Store Provenance (PR #1539)

PR #1539 added the release-store provenance path: the verifier in `scripts/release-provenance.mjs`, the updater's use of it in `scripts/update-botfleet-mac.mjs`, and the identity a harness reports when it runs from a store release.  This section records how to qualify that path.  It is partial work under BF-2649 and does not close it.

### What A Passing Run Does Not Grant

A passing fixture run is not permission to restart, activate or install anything.  It proves the code paths below in temporary directories and says nothing about a running Mac.  The performance finding on PR #1539 is disputed and stays under the owner's hold; nothing in this section settles it.

### Fixture Recipes

Commands 1 to 3 build their own temporary git repositories and release trees under the operating system's temporary directory and remove them.  Commands 4 and 5 only read `package.json`.  None of them contacts a harness, the installed app or the network.

```sh
# 1. The verifier.
node --test scripts/release-provenance.node-test.mjs

# 2. The updater's release-store path.
node --test --test-name-pattern "storeHarnessState|capturePrevious|clearStoreIdentityError|reuse deploy|prepareStoreReleaseDeploy|deployStoreReleaseIfBacked|installReferenceDeps|materializeCandidate|reuse preparation" scripts/update-botfleet-mac.node-test.mjs

# 3. The identity a harness reports from a release.
node --test electron/runtime-identity.node-test.mjs

# 4. The release command's flag guard.
node --test scripts/harness-release.node-test.mjs

# 5. The pin that keeps 1 and 4 in the repository gate.
node --test scripts/gate-wiring.node-test.mjs
```

What each one proves:

1. **The verifier.**  A release tree is compared with the commit's git objects byte for byte.  A changed, missing or extra file is drift and is named.  File type and the executable bit are compared in both directions, and a Git LFS file is accepted by its pointer's hash and size without ever waiving type or mode.  The store manifest and a genuine `.DS_Store` are accepted as content the commit does not hold; planted bytes under the `.DS_Store` name are drift.  A dependency tree is never treated as absent: without a trusted reference it is unverified, and a link that leaves the tree, dangles or reaches outside through a second link is a custody problem.  A repository that cannot answer is reported as unable to check, never as drift.
2. **The updater's release-store path.**  The running root must be a manifest-bound release inside the store's own release directory, and only the two identity refusals can be cleared by outside verification.  The staged export is proven before any install hook runs and again after, hooks never run against an unproven export, and a refused deploy leaves the pointer where it was.
3. **The reported identity.**  A byte-verified release reports its commit as clean.  A drifted release refuses the commit, a release no repository can check stays dirty, and a release with unverifiable dependencies names its commit but stays dirty.
4. **The release command.**  `--version` never takes the next flag as its value.  The second case checks that the pin in command 5 is itself named by `test:ci-scope` and chained by `pnpm test`.
5. **The gate pin.**  `test:mac-updater` must be exactly `node --test` followed by literal test file paths, must name the suites of commands 1 and 4 as whole paths, and must be chained by `pnpm test` as its own step.  A flag, a shell operator or a glob in that script fails it, because each can name a suite without running it or without being able to fail.  No script may reach the opt-in install qualification, by any spelling of its name or by a glob that covers it, without the switch in the same step.

What the pin can and cannot see: command 5 runs from `test:ci-scope`, not from `test:mac-updater`, so a change that drops the provenance suites from `test:mac-updater` fails command 5, and a change that drops command 5 from `test:ci-scope` fails the second case of command 4.  One change that drops both lines at once passes unseen, and so does a workflow that stops running `pnpm test`; `scripts/ci-change-scope.node-test.mjs` pins the workflow step separately.

Observed on Nov 17, 2026, in a task lane at `e23494c0` on Linux with Node 22.22.1 and an unprivileged user:

| Command | Tests | Passed | Skipped | Failed |
|---|---|---|---|---|
| 1 | 40 | 40 | 0 | 0 |
| 2 | 52 (29 matching cases and their subtests) | 50 | 2 | 0 |
| 3 | 23 | 23 | 0 | 0 |
| 4 | 2 | 2 | 0 | 0 |
| 5 | 7 | 7 | 0 | 0 |

Two changes to `package.json` were also tried and undone in that lane.  With the two provenance suites removed from `test:mac-updater`, `pnpm test:ci-scope` reported command 5's case `the repo gate runs the release-store provenance suites` as failed, naming both missing files.  With `scripts/gate-wiring.node-test.mjs` removed from `test:ci-scope`, command 4 reported 1 passed and 1 failed.

Limits of that evidence:

- The two skips in command 2 are the `materializeCandidate` custody cases.  They need APFS `clonefile` and run only on macOS, so the Linux run above does not cover them.
- One case in command 1 (`an unreadable dependency root is unverifiable, never absent`) skips when run as root, because root bypasses the file modes the fixture is built on.  Run the recipe as an unprivileged user.
- The counts above came from Node 22.22.1, which is older than the Node 24 floor in `package.json`.  Hosted CI runs Node 26, and no run on a supported Node is recorded here yet.

### Where These Run In Hosted CI

`pnpm test` reaches commands 1 and 4, and the whole file behind command 2, through `test:mac-updater`.  It reaches command 3 through `test:server-boot-probe` and command 5 through `test:ci-scope`.  No script named commands 1 and 4 until they joined `test:mac-updater` together with this section, so they had never run in hosted CI before that.

Both legs of the hosted `typecheck + test` job currently run on Ubuntu (see the matrix comment in `.github/workflows/ci.yml`).  Until a macOS leg returns, no hosted job runs the two macOS-only custody cases.

### Opt-In Real-Install Qualification

**Not yet executed for this record.**

```sh
BF_PROVENANCE_INSTALL=1 node --test scripts/release-provenance-install.node-test.mjs
```

It exports one commit into two temporary directories, runs `pnpm install --frozen-lockfile` in each with normal links and install hooks, and then requires the two dependency fingerprints to be identical, every link to stay inside its tree, and both trees to verify against the commit's git objects.

Preconditions.  The first two are stated in the test's own header; the others are read from its code:

- A complete checkout of the reviewed commit.  A partial archive omits workspace manifests and patches the install reads.
- The `pnpm` on the path is the version pinned in `packageManager`.  The test asserts this before it installs.
- Network access for the two installs.  Each install is allowed up to 30 minutes.
- `BF_PROVENANCE_COMMIT` names another commit (default: `HEAD`), and `BF_PROVENANCE_REPO` names another repository (default: the current directory).

What it leaves behind: the two exported trees live under the operating system's temporary directory, and the test removes them.  Nothing else is cleaned up.  Each install is an ordinary `pnpm install` with the caller's environment and no store directory of its own, so it also fills pnpm's package store and metadata cache, and it runs the install hooks that `pnpm-workspace.yaml` allows, which download the Electron distribution and the `sentry-cli` binary.  Those writes land outside the two temporary directories, in the running account's own store and cache locations.  This record did not measure their size; check free disk space before running it on a tight host.

Without the switch the file reports one skipped test and nothing else (observed on the same day: 1 test, 0 passed, 1 skipped).  No script or workflow names it, and it is deliberately left out of `test:mac-updater`: a skip in the default chain would read as coverage that never ran.

### Not Yet Executed — Requires A Mac Seat And The Normal Authorized Route

This is a qualification step on a real Mac, not a fixture recipe.  It was derived from the source and nobody has run it for this record.  It does not restart, activate or swap the pointer, and it installs nothing into the app, the updater's checkout or the release store.  It is not free of side effects.  Step 1 fetches and can write the updater's helper cache, and step 5 cannot reach `verified` without a dependency install.  Each side effect is named in the step that causes it, and an approval given for a read-only check does not cover them.

Record what each step actually prints; do not copy expected output from here.  Never print or record the owner nonce (step 3).  Stop at the first surprise and report it.

1. Run `ubf status`.  The `status` command takes no updater lock.  It reports the installed app's version, build and commit, any staged update, pending recovery, backups, the last result and an update already in progress (`collectUpdateStatus`).  Stop if an update is in progress or a recovery is pending.  It does not report the release store, the running root or drain state, so the steps below are still needed.  Its side effects, read from the two wrapper sources (this record did not check which entrypoint a given Mac has installed):
   - The protocol-v1 loader (`scripts/update-botfleet.sh`) fetches `origin/main` into the updater's checkout for every command, `status` included, and then publishes the updater helper for that commit (`publishHelper` in `scripts/update-botfleet-bootstrap.mjs`).  Unless the helper cache already holds a verified generation for that commit, it writes a new `<commit>-<uuid>` directory under `~/Library/Caches/BotFleet/helper` (or `BOTFLEET_HELPER_CACHE`) and replaces `current.json` there.  Nothing in that path removes older generations.
   - The policy wrapper (`scripts/update-botfleet-policy.sh`) fetches again and assembles the updater in a temporary directory, which it removes.
2. Run `node scripts/harness-release.mjs status` from the updater's checkout.  It prints where the store's `current` pointer resolves, the commit that release is bound to, and whether the directory is an immutable release.
3. Confirm the running root.  The updater resolves the owner process's working directory with `lsof -Fn -a -p <pid> -d cwd` (`runningRootOfPid`).  That physical path must be the store's release directory for the commit its `.botfleet-release.json` names, and the manifest's commit must equal the directory's name (`clearStoreIdentityError`, `assertStoreReleaseRunning`).  Between a pointer swap and a restart the pointer and the running root can name different releases, so check the process, not the pointer.  The updater takes the process id from the `pid` field of `harness-owner.json` in the data directory.  That file also holds the private owner nonce, which the updater treats as a credential (`BOTFLEET_OWNER_NONCE`): read only the `pid` field, and never print or record the file, the nonce or a request that carries it.
4. Confirm the bytes.  `verifyReleaseAgainstCommit` must return `ok: true` for that root, that commit and the updater's checkout.  A `drift` answer names what moved.  `unverifiable` means the dependency scope could not be read, or the reference offered for it cannot be trusted.  `repo-unavailable` and `commit-missing` mean the check could not run.  None of the four is a pass.
5. Confirm dependency custody, or record that it was not proven.  `ok: true` is not enough here: the verdict's `dependencies` field must be `verified`, and the verifier answers `verified` only against a trusted fingerprint or reference tree from outside the release.  The source offers two origins for one, and neither is an inspection:
   - A fingerprint captured by a deploy run (`releaseDepsFingerprint`, set inside `prepareStoreReleaseDeploy`).  That run stages and promotes a release, which this checklist excludes.
   - A fresh reference install (`installReferenceDeps`): an export of the commit into a temporary directory, then `pnpm install --frozen-lockfile` there with install hooks and network, allowed up to 30 minutes.  The export is removed afterwards; what the install adds to the pnpm store and the download caches is not (see the opt-in qualification above).

   The reference install is a second side effect and needs its own approval under the normal authorized route.  Without it the verifier answers `unverified` for any release that carries `node_modules`.  Record that as dependency custody not proven, never as a pass: a verified source tree says nothing about the installed dependencies.
6. Confirm drain state from the authenticated `/api/runtime` answer the updater reads: `drain.bots`, `drain.rooms` and `drain.inFlight`, or `activeWorkCount` on a harness that predates drain reporting (`drainProgressDetail`).  The idle gate requires `safeToRestart` to be true and no active work.  The request is authenticated with the owner nonce, so record only the drain and identity fields of the answer, never the request.

Steps 4 to 6 name the functions and fields the updater uses.  They do not name a ready-made read-only command for an operator, because this record found none in the source; whoever runs this step chooses the invocation under the normal authorized route and records it without the nonce.
