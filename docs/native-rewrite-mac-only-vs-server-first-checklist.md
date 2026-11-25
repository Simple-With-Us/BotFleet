# Mac-Only Vs Server-First Checklist (BF-2498)

The operational checklist for choosing between the two daily-driver modes and
verifying each one holds.  It condenses the mode definitions in
[Native Server Mode](plans/2026-10-29-native-server-mode.md), the acceptance
recipes in [Placement And Ownership Evidence](verification/placement.md), and
the cutover state in [the single-writer cutover runbook](native-rewrite-single-writer-cutover.md)
into one place a person can walk before and after the cutover.  Refs BF-2498,
BF-2544, BF-2559, BF-2514, BF-2515, BF-2622, BF-2628, BF-2689, BF-2691.

Surveyed at commit `55bb03b67` (2026-11-23).  This file is a checklist, not
evidence:  every acceptance item points at the recipe or landed artifact that
must pass, and no checkbox here is assertable from a green typecheck or a code
read.  The evidence itself lives in
[placement-evidence.json](verification/placement-evidence.json), and as of
this survey all seventeen assertion keys are false.

## The Modes

| Mode | Controller | Workers | Dispatches while the Mac sleeps | Enabled when |
| --- | --- | --- | --- | --- |
| `localOnly` (default) | this Mac | this Mac | nothing dispatches; the record is local | always; the default on every install |
| `serverFirst` | the chosen server | the server and this Mac | the server keeps dispatching (the reason Jay wants it) | a saved server has passed the handshake and answers the placement routes |
| `macFirst` | this Mac | this Mac and the server | nothing dispatches while the Mac sleeps | the same verified-server handshake |

The two server modes stay visible-but-disabled until a saved server passes the
handshake (identity, host id, version, auth, capabilities, placement routes);
the captions for each disabled reason live in
`ios/Sources/CompanionCore/PlacementModeAvailability.swift`.  Pins
("Run on: Automatic / This Mac / \<server\>") are independent of the mode.
Interactive turns are not placed in version one; they run on the host the
person is talking to.

## Part 1, Choosing

- [ ] Does any job need to run while this Mac is asleep?  If yes, the answer
      is `serverFirst`, but read the Mac-asleep gap below before promising it.
- [ ] Does this Mac hold work only it can run (desktop control, `xcodebuild`,
      pairing)?  Pins cover that in every mode.
- [ ] Is there any saved, verified server at all?  With none, the mode is
      `localOnly` and the word "server" should appear nowhere outside
      Settings › Servers.
- [ ] Migration from Electron: `local` maps to `localOnly`; `remote` maps to
      `serverFirst` with overflow off and the vault URL as the one saved
      server.  The Infisical bootstrap stays optional and is never required
      for the Mac-only path.

## Part 2, Mac-Only Operation (`localOnly`)

- [ ] A fresh install with an empty store completes a normal job with no
      server configured and no requests off loopback, recipe
      `fresh-mac-only-install`, and the BF-2544 acceptance.
- [ ] No vault, no account, no pairing is required for ordinary local
      functionality; the mode and headroom live in the native store.
- [ ] Swap and disk gates still refuse or queue new work with the reason
      shown; a broken probe admits and says so rather than switching the Mac
      off.
- [ ] The native update path works without the server (BF-2628: the signed
      feed and the packaged updater; the draft release publish and the
      installed-upgrade acceptance remain owner-side).
- [ ] Standalone execution gaps are tracked, not assumed closed:  the native
      execution context, engine-driver registration, event actor and
      scheduler wiring are BF-2689's scope, and until that lands Mac-only
      mode does not claim full Node-free execution.
- [ ] Credential reads follow the current binding rules:  the shared scoped
      reader with this consumer's own read-only service token; a Mac-only
      install with Infisical off disables the affected features with a
      redacted reason instead of reaching for the environment.

## Part 3, Server-First Operation (`serverFirst`)

- [ ] `server-first-placement` passes:  automatic jobs run on the server,
      pinned jobs on the Mac, capability-refused pins (`xcodebuild`) stay on
      the Mac, and only the controller holds job records.
- [ ] The Mac-asleep profile is its own recipe and its own evidence:
      `server-first-mac-asleep-iphone` currently stays false because nothing
      on the Linux server dispatches APNs notifications while the Mac listener
      is asleep.  An awake server-first run is not proof of it.
- [ ] Overflow semantics are understood and set deliberately:  with "Allow
      Overflow To This Mac" on (the default in this mode) the Mac takes
      overflow when the server is at budget; with it off the Mac runs only
      Mac-only and pinned work.
- [ ] Keys for work that runs on the server are set on that server, per host;
      the Mac never forwards a credential to a worker.
- [ ] `server-saturation-overflow` and `both-hosts-pressure-queue` pass:
      refusal reasons are visible while queued, and each job still runs once.
- [ ] `mode-change-fence` passes:  a switch with an active Mac-owned job is
      refused with the count; a clean switch writes epoch N+1 on both hosts
      and stale epoch-N messages spawn nothing.
- [ ] `forced-takeover-and-return` and `rollback-keeps-epoch` pass before
      trusting "Take Over On This Mac…":  orphans are visible, held runs are
      chosen deliberately, and restored epoch-N data converges to N+1.
- [ ] `disconnect-no-duplicate` passes:  a cut link produces
      `worker-unreachable`, spooled reports apply once, and lease
      acknowledgements are idempotent.
- [ ] `connect-and-revert-clean` passes before treating the server as
      removable:  clean return to `localOnly` leaves old records unchanged and
      the loopback guarantee intact.

## Part 4, Mode-Change Fences (Both Directions)

- [ ] `serverFirst` → `localOnly`/`macFirst` clean:  the server is reachable
      and no server-owned job is active, or the person stops them.
- [ ] `serverFirst` → `localOnly` forced:  the one transition that may leave
      work behind; the dialog lists server-owned jobs, held runs get an
      explicit run-or-drop choice, and post-cut server work is labelled, never
      rerun.
- [ ] Every transition logs the epoch before and after, and the Settings
      status row shows when the current mode began.

## Part 5, What This Checklist Does Not Claim

- [ ] BF-2622 runtime acceptance stays open elsewhere:  live handoff of
      managed bindings, real scopes, write-through and encrypted credential
      replay are that row's lane, not this checklist's.
- [ ] Recipes 11, 12 and 13 need Jay's recipe-specific go-ahead with Jay
      present; the evidence checker requires all seventeen keys true, both
      inventory artifacts and every hand-run record before the decommission
      state may assert `placement-evidence`.
- [ ] The Mac host inventory (the `inventory.mac` artifact) is assigned to a
      Mac seat and needs Jay's yes to run the read-only collection; the
      server half ran on Nov 17 and 18, 2026.
- [ ] T9 activation permission stays with the owner; T5/T6b/T7 fixture
      results and receipts are separate from it.

## Sources

[Native Server Mode](plans/2026-10-29-native-server-mode.md) ·
[Placement And Ownership Evidence](verification/placement.md) ·
[The Single-Writer Cutover Runbook](native-rewrite-single-writer-cutover.md) ·
[The Electron Responsibility Inventory](native-rewrite-electron-inventory.md) ·
[The Electron No-Delete Map](native-rewrite-no-delete-map.md) ·
[Placement T9 Activation Scope](plans/2026-11-22-placement-t9-activation-scope.md)
