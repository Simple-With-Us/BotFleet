# P-BF-6 Completion Gap Register (2026-11-28)

Basis: `origin/main` at `5654e0284`, Linear team BF read as seat MC on
2026-11-28, and lane verification on this Mac.  Scope per the owner for
this pass: iPhone and Mac.  iPhone Duo and iPad optimization stay
deferred.  Every row names its evidence; a Linear state is reported as
read, never as proof the tree matches it.

## Phase State

| Gate | Linear state | Tree/host reality |
| --- | --- | --- |
| Phase 5 cutover (BF-2514) | Deployed | The 24-hour no-Node soak closed 2026-11-27.  Caveats on the row: no native bot turn shown on the Mac in the window (that is BF-2689 acceptance), the rehearsed rollback artifact was removed by the owner-directed uninstall, and the Mac app was not running at the final check.  |
| Phase 6 decommission (BF-2515) | Done | The Mac-local Node stack is retired, but main still tracks 884 files under `server/` and 177 under `companion/` plus `electron/`, retained for the optional Linux server (BF-2544).  "Done" therefore means the Mac-local retirement and its gates, not deletion of the roots.  Readers must not cite the state as tree absence; `scripts/check-decommission-tree.mjs` remains the absence test and would fail today by design of the retention exception.  |
| Unified conversation (BF-2444) | Done | Direction and plan only.  Implementation is Slices 0-3 in `docs/plans/2026-10-31-unified-conversation-and-context-policy.md`, with four open product questions still awaiting the owner.  |

## Fixed In This Pass

- **BF-2718** ([#2255](https://github.com/Simple-With-Us/BotFleet/pull/2255)):
  the tracked `ios/MacApp/Info.plist` lacked the four Sparkle keys
  `ios/project.yml` declares, so a plain-checkout build shipped an
  updater reporting updates unavailable.  The plist is regenerated and
  `scripts/check-xcodegen-drift.mjs` now fails both CI jobs that run
  `xcodegen generate` when tracked output drifts.  Lane evidence: the
  gate fails on the pre-fix tree naming the plist, passes after the
  sync, its test passes 6 of 6, `pnpm typecheck` passes, and the
  unsigned iPhone build succeeds.
- **BF-2719** ([#2256](https://github.com/Simple-With-Us/BotFleet/pull/2256)):
  four `scripts/decommission-gate-state.node-test.mjs` cases failed
  whenever TMPDIR used the macOS `/var` spelling, because the resolver
  returns the realpath it validated while the tests expected the
  uncanonical root.  The tests canonicalize their temp roots; 16 of 16
  pass where the untouched base failed 4.  Until this fix,
  `pnpm test:native-release` was red on this Mac for an environmental
  reason unrelated to any change under test.

## Remaining Claimed Work (Do Not Duplicate)

- **BF-2689** (In Progress): native engine wiring is merged in slices
  (#2199, #2206, #2220, #2239 and the BF-2705 series), and the legacy
  import landed as **BF-2710** (#2244).  What remains is acceptance: a
  signed build showing imported bots, a real This Mac turn and reply
  with no Node harness, and a clean-profile first-bot flow.  This is
  the single gate between P-BF-6 source completion and a user holding
  the native app.
- **BF-2635** (In Progress, draft #2246): the optional native headless
  host artifact waits for a seat whose git route may write a workflow
  file.
- **BF-2559, BF-2622, BF-2647, BF-2527, BF-2678** (In Progress):
  server-first placement remainder, optional Infisical, replay parity
  producer, Control start-server, and iOS Markdown tables.  Each has a
  live claimant; help goes through their topics, not parallel lanes.

## Owner-Gated (No Seat Can Finish Alone)

- Publishing the signed native Mac release draft
  `v0.1.0-202611271505-native` (OPS-1136): drafts made by the workflow
  token are invisible to seat apps, so the publish click is the
  owner's.  **BF-2716** is the lasting fix and waits for the owner's
  yes because it changes a release rule.
- **BF-2717**: twelve two-harness placement recipes, built only if
  the owner activates T9.  The port inventory keeps
  `placement-evidence` unmet until the complete recipes pass.
- BF-2444's four product questions (default context budget,
  send-to-inactive-context default, merged-history presentation, iOS
  Slice 0 ordering) block Slices 1-2; Slice 0 itself needs no new
  product decision.

## Gaps By Surface

### iOS App

- **Browse-while-busy is still the open defect on the phone.** The
  unified plan records that `ChatListView.openTask` switches tasks on
  open (refused with 409 while the bot works) where the Mac already
  views without switching.  Slice 0 items 1 and 4 (per-thread
  transcript reads; view-instead-of-switch) are the fix and are
  unbuilt.  Until they land, the BF-2444 source complaint stands on
  iOS and web.
- **Verification reach:** Bitrig previews only its registered project
  folder (the integration checkout), never a fleet lane worktree, so
  lane UI work cannot be shown through `bitrig preview` today.  Lane
  verification falls back to the CI commands (unsigned `xcodebuild`,
  `swift test`), which this pass used.  A lane-aware preview route
  would close the loop the owner asked for (build, run, inspect).
- iPhone Duo and iPad layouts are intentionally untouched in this
  pass per the owner; nothing in the register should be read as Duo
  readiness.

### Mac App

- **No signed-build native turn receipt yet** (BF-2689 acceptance
  above).  Source slices are merged; the proof is not.
- **Rollback is weaker than the BF-2514 text implies.** The rollback
  rehearsed 2026-11-26 depended on the archived release and launcher
  that the 2026-11-27 uninstall removed.  A rollback today is a fresh
  install from a published artifact plus retained user data, and the
  runbooks should say so wherever they still describe the rehearsal.
- **Control disposition** (`control-disposition`, BF-2583) remains a
  decommission gate input: `mac-control/` is Swift, but its local
  half was built against the retired `:8799` routes and LaunchAgents,
  and the audits in `docs/plans/2026-10-29-botfleet-control-after-node.md`
  name the replacement work that no P-BF-6 issue yet carries.

### Shared Framework (CompanionCore)

- The Swift tree carries no TODO/FIXME markers (`ios/Sources`,
  `ios/App`, `ios/MacApp` all count 0), so deferred work is tracked
  in Linear rather than in code comments.  The register found nothing
  to file from comment debt.
- **Placement contracts are source-complete but evidence-open.** The
  inventory rows for `server/host-id.ts`, the placement lease/store
  family and the controller bridge each repeat that
  `placement-evidence` stays unmet until the complete recipes pass
  (BF-2559/BF-2717).  Swift decoding landed (BF-2596); activation and
  worker transport remain gated.
- **Linq is deferred by owner ruling** (2026-11-23, BF-2617) and is
  correctly not a cutover blocker; the webhook route stays with
  BF-2513.  Any future Linq work needs a fresh ruling, not a lane.

### Server Backend

- **Retention is a feature, and it costs clarity.** The Linux server
  keeps `server/`, `shared/`, the Vite UI build and the root
  manifests alive as one closure (`docs/plans/2026-11-03-node-decommission-source-plan.md`).
  P-BF-6 therefore ends with two supported runtimes (native Mac,
  optional Linux Node), and every future `server/` change must keep
  landing a port-inventory row.  The inventory gate is the control;
  keep it.
- Two decommission-plan open questions still have no owner: the
  required-check list of ruleset `21771270` is not determinable from
  the tree, and the `harness` dependency in `package.json` has no
  import site anywhere.  Both are one-line answers blocking clean
  Phase 6 bookkeeping.
- GitHub reports 34 Dependabot vulnerabilities on the default branch
  (10 high, 21 moderate, 3 low; seen in the push banner 2026-11-28).
  None was triaged in this pass; the highs deserve their own issue
  sweep before the next server release.
- Unclaimed and actionable: **BF-2711** (`hdiutil` deprecated on
  macOS 27; release-path, must ride its own PR under the human
  judgment gate) and **BF-2709** (replay parity families for cursor,
  gemini-cli, dsh and opencode).

### Tooling And Process

- **Skill docs lag the protocol.** `.agents/skills/session-start`
  and `.agents/skills/fleet-coordination` still teach Slack and the
  retired `board` CLI, while `AGENTS.md` makes Linear (`simple-board`)
  and Zulip (`simple-chat`) authoritative.  A new seat following the
  skills first will claim in the wrong system.  Refresh or banner
  both skills as historical.
- **Hosted remote mode rejects options the docs show.** Verified
  2026-11-28 as MC: `simple-board list` rejects `--app` and
  comma-separated `--status`; `claim` rejects `--where`; `file`
  rejects `--by` and `--desc-file` (and defaults to the OPS team
  without `--app botfleet`); writes need `SIMPLE_BOARD_REMOTE_WRITES=1`
  / `SIMPLE_CHAT_REMOTE_WRITES=1`; `simple-chat post` rejects
  `--no-tag`, `--quiet` and `--body-file`.  `AGENTS.md` already warns
  that hosted and local contracts differ, but its copy-paste examples
  are the local forms.  Add the hosted equivalents beside them.
- **Seat identity in GUI shells:** the Bitrig shell starts with
  `AGENT_SEAT` empty, so `recall` and `simple-board` fail closed
  (missing embedder/Linear credentials) until called with
  `AGENT_SEAT=MC`, when the seat bearer route works.  Seats keep
  rediscovering this; it is now in MC's project memory and belongs
  in the onboarding checklist.
- The integration checkout root carries about twenty untracked
  scratch files (`patch*.cjs`, `fix_*.py` and friends) that are in
  no lane and no commit.  They are owner property and were left
  untouched; a five-minute owner sweep (keep, move or delete) would
  return `git status` there to a trustworthy signal.

## Recommended Order

1.  Publish the native release draft (owner click) and run the
   BF-2689 signed-build acceptance; that closes P-BF-6 as a product.
2.  Land BF-2716 so the next release needs no manual publish.
3.  Answer BF-2444's four questions, then build Slice 0 on iOS and
   web (the Mac already complies).
4.  Give BF-2635 a workflow-capable seat route; take BF-2711 as its
   own gated PR; sweep the Dependabot highs.
5.  Refresh the two stale skills and the hosted-mode examples so the
   next seat starts from true instructions.
