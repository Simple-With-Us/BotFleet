# 2026-09-22 — Updater Transition Release (ships before the bundle rename)

This is the **transition release** for the macOS bundle rename in PR #524 (`minimax/bundle-rename`).  It must merge **and be applied to every Mac** before #524 merges.  It changes no bundle identifier: main still builds and signs `com.botfleet.app`, and the LaunchAgent on disk is still `com.jay.botfleet-server`.

## Why a separate release

On an installed Mac, `~/apps/update-botfleet.sh` is a machine copy of the wrapper.  The updater never rewrites it, so today it is main's old wrapper.  That wrapper execs `~/apps/update-botfleet-mac.mjs` if present, otherwise the updater in the always-on checkout (`~/apps/botfleet-server/scripts/update-botfleet-mac.mjs`) at whatever commit the checkout is on.

If #524 merged first, the first post-merge update would run main's old updater from the checkout.  None of #524's bootstrap code would run, and the old updater would abort on the renamed candidate (`app.botfleet.macos` is not `com.botfleet.app`).

This release is an ordinary main-to-main update: bundle IDs are unchanged, so the old updater applies it normally.  Once applied, the checkout's updater is the transition-capable one, and the NEXT update (the rename) is judged by code that knows both identities.

## What this release ships

`scripts/update-botfleet.sh` (tracked wrapper), ported from #524:

- Bootstraps updater policy from the target ref: archives the updater module graph from the fetched target and runs that immutable copy, so the target's own rules validate its candidate.
- Ancestry gate: the target must resolve to a full commit reachable from `origin/main` before any of its code is archived or run.
- `apply --stage` bootstraps the updater recorded in the stage's `prepared.json` `sourceCommit`; an unreadable manifest fails closed.
- Forced fetch of the bootstrap ref (and `origin/main`) even for `--force` runs.
- Linked-worktree detection with `git rev-parse` instead of testing for a `.git` directory.
- bash 3.2-safe `UPDATER_ARGS` expansion.
- Up-to-date shortcut scoped to a plain `update` to `origin/main`.
- `BOTFLEET_UPDATE_TARGET` and `--target` / `--target=` forwarded to both bootstrap policy and candidate.

`scripts/update-botfleet-mac.mjs`, ported from #524 with one transition-only difference:

- `--target=REF` accepted.
- Installed-app capture accepts the legacy `com.botfleet.app` identity (`allowLegacyBundleId`).
- `applicationIdentitiesCanTransition()`: a renamed `app.botfleet.macos` candidate may replace a legacy install (same team) or a renamed install with the same designated requirement.  **Transition-only:** a legacy `com.botfleet.app` candidate is still accepted, but only over a legacy install with the same designated requirement (the pre-transition rule), so ordinary main updates keep working until the rename lands.  A legacy candidate never replaces a renamed install.  Built-bundle validation and `loadPrepared()` accept either ID; any other ID is rejected.
- Label tracking for both `app.botfleet.server` and legacy `com.jay.botfleet-server`: capture, quiesce and rollback boot out whichever is loaded.
- Harness plist selection: bootstrap `app.botfleet.server.plist` once it exists, otherwise the legacy plist.  On a pre-rename Mac this is the same plist and label as today.
- Rollback hardening: boot out the label `startHarness` actually started, restore from plists that exist, and verify the restored app against its own (possibly legacy) identity.

Regression tests: `scripts/update-botfleet-mac.node-test.mjs` (wrapper bootstrap, ancestry gate, stage bootstrap, worktree, bash 3.2, shortcut scoping, label and plist selection, rollback), plus transition-only tests for legacy-candidate acceptance and `loadPrepared()` of either ID.

Not in this release: `electron-builder.yml` `mac.appId`, entitlements, AASA, APNs topic, helper `Info.plist`s, iOS IDs, and every doc claim about renamed IDs.  Those stay in #524.

## Rollout order

1. Merge this PR.  CI green; no bundle ID changes.
2. Run the normal update on every Mac (`~/apps/update-botfleet.sh`).  The old updater applies it like any other main commit.
3. Verify on each Mac that the checkout contains this commit: `git -C ~/apps/botfleet-server merge-base --is-ancestor <this-merge-sha> HEAD`.  Also confirm `~/apps/update-botfleet-mac.mjs` does **not** exist; if it does, the old wrapper runs that file instead of the checkout's updater and this release does not reach it.  Remove it or sync it from the checkout first.
4. Optional: sync `~/apps/update-botfleet.sh` from the tracked `scripts/update-botfleet.sh` so later updates bootstrap the target's own updater.
5. Rebase #524 onto main (it conflicts on these three files), dropping the transition-only legacy-candidate acceptance so candidates are restricted to `app.botfleet.macos`.  Then merge #524 and update.
