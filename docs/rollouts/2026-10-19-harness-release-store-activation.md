# 2026-10-19 — Activating The Release Store: The Harness Stops Running From A Checkout

repo: BotFleet | seat OPENCODE | board `BF-2517` (plugin platform) and the
owner directive of 2026-10-19: daily operation must not rely on a git
checkout.

## What "the always-on checkout" meant

The always-on Mac harness ran from a **linked git worktree of the human's
own tree**, checked out at a detached `origin/main`.  The LaunchAgent's wrapper `exec`ed
`node --experimental-strip-types server/index.ts` out of it, so the
process serving the UI, the phones, the webhook receiver, and the Zulip
listener was running code out of a working tree that any seat could
`git checkout`, `git reset --hard`, delete files from, or have pruned out
from under it.

Three real failures came from that shape, all recorded before this work:

- 2026-09-19: a seat's branch deleted a file the harness still imported,
  and the always-on checkout was silently six PRs behind `origin/main`
  while the UI kept answering 200 from its own health route.
- 2026-10-14: the janitor removed `node_modules` from the running
  checkout, and the wrapper's self-heal then reinstalled dependencies
  *underneath a live server* that was serving HTTP and holding SQLite
  writes.
- Every update `git checkout --detach`ed that worktree and renamed a fresh
  `node_modules` into place under the running process, so an unverified
  new version had no rollback: the old tree was already gone.

The repository already had the answer — PR #858 (merged 2026-10-06) added
`scripts/harness-release-store.mjs`: immutable per-commit release
directories, a `staging` area, one atomically swapped pointer, and a
launcher that refuses to mutate a release.  What was missing was the half
that makes it usable: nothing staged or promoted a release, and the
LaunchAgent still pointed at the checkout.  The rollout doc for #858
called that "a separate on-demand operator step that pauses for the
owner".  The owner's directive is that pause being released.

## What changed here

**Staging (the missing half).**  `stageRelease()` in
`scripts/harness-release-store.mjs` exports a commit with `git archive`
into `staging/<commit>` and installs its dependencies there with
`--frozen-lockfile`.  It reads an object and writes bytes: it never
checks a branch out, never touches a worktree, and never mutates the
repository it reads from — preparing a release cannot disturb the tree
that is currently running.  The module keeps its "node builtins only"
rule, because it is about to be imported by the updater's bootstrap
archive, which has no `node_modules` beside it.

**An operator entry point.**  `scripts/harness-release.mjs` exposes
`stage`, `promote`, `swap`, `activate`, `status`, `list`, and `prune`.
`activate` does the whole sequence and prints where the pointer ended up.
Failures print the reason and a cause code, not a stack trace.

**The launcher prefers the store.**  `scripts/botfleet-server-start.sh`
now resolves `~/.botfleet/current` as the runtime root when that pointer
exists, and keeps the legacy checkout path as the fallback for a machine
that has never promoted a release.  `BOTFLEET_SERVER_ROOT` still wins,
so tests and operators can point it elsewhere.

**The agent points at the pointer.**  `scripts/launchd/app.botfleet.server.plist`
sets `BOTFLEET_SERVER_ROOT` to the store's `current` pointer and moves
`WorkingDirectory` to the store root, which always exists, rather than the pointer, because launchd refuses to start
a job whose working directory does not exist, and a missing pointer must
fail inside the launcher (with its own message) rather than silently
leaving the job unloaded.

## The shape after this

```
~/.botfleet/
  current -> releases/b25cba78d…        # the one thing an update moves
  releases/b25cba78d…/                  # immutable, read-only, named by its commit
    server/index.ts
    node_modules/
    .botfleet-release.json
  releases/<previous>/                  # kept: the rollback target
  staging/<commit>/                     # work in progress, never activated
```

The harness runs from `releases/<commit>`.  An update prepares a new
release somewhere else entirely and swaps one symlink.  The previous
release stays on disk, so an unverified new version costs one rename
rather than an outage.

## Verification

- `node --test scripts/harness-release-store.node-test.mjs` — 36 pass,
  including the new staging cases: the export leaves the source
  repository byte-identical and with a clean worktree, a non-commit value
  is refused, a missing commit is reported by name, and a staged commit
  promotes into an immutable release with the pointer moved onto it.
- `node --test scripts/botfleet-server-start.node-test.mjs` — 27 pass,
  including the two new cases: the launcher runs from the physical
  release directory when the pointer exists, and still runs from the
  legacy path when it does not.
- The live Mac was migrated and the harness started from the release:
  its working directory is the release, not the checkout, and the Zulip
  sessions reconnected with the vault identity, which proves the
  identity still reaches a release-launched harness.

## Follow-ups

1. The updater (`ubf`) still prepares releases from a checkout and does
   not use the store's staging path.  Until `ubf` promotes and swaps,
   the store is operator-driven: one command, then a restart.
2. The updater's own `CHECKOUT` default still points at
   the deployment checkout.  That is a build source, not a runtime root,
   so it is not a daily-operation dependency — but it should move to the
   same immutable story eventually.
3. The deployment checkout is now a build source only.  It can be
   retired once the updater prepares releases from fetched objects.
