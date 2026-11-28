# P-BF-6 Live Status And Handoff (Seat MC)

Last updated: Sat, Nov 28, 2:00 AM, by MC (Muse in Bitrig, session
`01a2207d-76b3-71d2-8dfa-e6839f3b36d6`, name wheat-asteroid).  Mirror:
Apple Note `[BF, Muse] P-BF-6 completion pass` (Coding folder,
`p13006`).  The durable audit behind this note is
`docs/audits/2026-11-28-pbf6-completion-gap-register.md` on main.

## How To Keep This Note True

Update this file every time a sub-task finishes, in the same commit or
the next one: move its row, append one Sub-Task Log line with the
owner-clock time, push this lane's branch, and refresh the Apple Note
with `AGENT_SESSION=<your session id> /Users/jay/apps/apple-notes-coding.sh --update "[BF, Muse] P-BF-6 completion pass" "<body>"`.  A model taking
over mid-stream should be able to continue from this file plus the
linked PRs alone; if a fact here and a live system disagree, believe
the live system and fix this file first.

## Identity And Routes (Verified 2026-11-28 As MC)

- Seat is `MC` (Muse; branches `muse-code/*`; PR header `[MC]`).
  GUI/Bitrig shells start with `AGENT_SEAT` empty: prefix every fleet
  CLI call with `AGENT_SEAT=MC` or it fails closed.
- Linear (hosted): `simple-board whoami`; list `--team BF --status <one>`;
  writes need `SIMPLE_BOARD_REMOTE_WRITES=1`; `claim <id> --by MC` only;
  `file --app botfleet` (no `--by`; without `--app` it lands in OPS).
- Zulip (hosted): `SIMPLE_CHAT_REMOTE_WRITES=1 simple-chat post --topic "<ID> <subject>" - < body-file`
  (stdin body; `--quiet`/`--no-tag`/`--body-file` rejected, so start the
  body with 👀 plus the plain header `[MC  📁 BF]`).
- Recall: `AGENT_SEAT=MC /Users/jay/.local/bin/recall "<q>" --limit 5`;
  contribute needs `SIMPLE_RECALL_REMOTE_WRITES=1`.
- Lanes only: never edit `/Users/jay/Code/BotFleet` (integration tree).
  This session's lanes live under `~/apps/lanes/BotFleet/muse-code-*`.

## Done And Landed

| Item | Evidence |
| --- | --- |
| BF-2718 XcodeGen drift gate | [#2255](https://github.com/Simple-With-Us/BotFleet/pull/2255) merged `67ee1d7e`; Linear Done; Zulip topic `BF-2718 XcodeGen plist drift` closed out. Seer entitlements finding fixed (`bb7bc61a1`, thread resolved); Kody never completed (first run incomplete, retries skipped, no findings). |
| BF-2719 gate-state temp roots | [#2256](https://github.com/Simple-With-Us/BotFleet/pull/2256) merged `db566196`; Linear Done; Zulip topic `BF-2719 Gate-state temp roots` closed out. |
| P-BF-6 gap register | [#2257](https://github.com/Simple-With-Us/BotFleet/pull/2257) merged `cd31b54b`. |
| Bitrig “cannot find in scope” errors | Root cause was the stale generated `ios/BotFleet.xcodeproj` (Oct 14) in the Bitrig checkout, not missing code. Fixed with `cd ios && xcodegen generate`, tracked plist restored (checkout clean), one stale Sentry PCM deleted under the Bitrig Builds DerivedData. `bitrig build` succeeds for `BotFleet` (iOS, 50 warnings) and `BotFleetMac` (macOS). `bitrig preview` built nothing: iOS preview paused, no macOS preview shown. |
| BF server build/start | `jay@jay-server.boa-roygbiv.ts.net` runs `/mnt/fleet-extra/apps/runtime/botfleet-server/code` at `67ee1d7e` = `origin/main`; all three units active, harness `ready: true`, bridge on `127.0.0.1:8797`. Update recipe below. |

## In Flight (Next Actions In Order)

1. **[#2259](https://github.com/Simple-With-Us/BotFleet/pull/2259)
   (BF-2720 fleet docs, head `fefc3c77b`)** — auto-merge armed.  Kody
   round 1 (2 findings: missing seat/write-switch prefixes, claim-step
   lane info) fixed and threads resolved; Kody re-requested on this
   head.  On merge: `simple-board status BF-2720 completed --resolution "Landed in #2259."`,
   Zulip closeout in topic `BF-2720 Hosted-mode fleet docs`, then move
   this row to Done.
2. **[#2258](https://github.com/Simple-With-Us/BotFleet/pull/2258)
   (BF-2711 diskutil image, head `5bd5b816a`)** — deliberately NO
   auto-merge: the issue keeps the human release-path gate.  Kody
   round 1 (3 findings: real-tool test, per-verb probe, spawn seam)
   fixed and threads resolved, one half declined with reason
   in-thread (workflow mount-check); Kody re-requested on this head.
   Next: confirm hosted CI green on this head, then leave it for the
   owner's merge decision.  After it lands, final acceptance is a
   dispatched `native-mac-release.yml` run on a macOS 27 runner; only
   then close BF-2711.  Local evidence: argv + real round-trip tests
   4/4, `test:native-release` 513 pass / 0 fail on macOS 27.2.1.
3. **This handoff note** — landed as #2260 (`8f953377`); keep updating
   it in small follow-up docs PRs as items above finish (this update
   is the first).

## Server Update Recipe (Exact, Reused Twice This Session)

```bash
ssh jay@jay-server.boa-roygbiv.ts.net 'sudo BF_ROOT=/mnt/fleet-extra/apps/runtime/botfleet-server BF_CODE=/mnt/fleet-extra/apps/runtime/botfleet-server/code bash /mnt/fleet-extra/apps/runtime/botfleet-server/code/deploy/linux-server/update.sh'
ssh jay@jay-server.boa-roygbiv.ts.net 'sudo systemctl restart botfleet-companion-bridge.service'
# verify: git log -1 in .../code equals origin/main, three units active,
# curl -s http://127.0.0.1:8799/health shows ready:true (allow ~30 s boot)
```

Notes: live paths differ from `deploy/linux-server/common.sh` defaults
(`apps/runtime/...`, code under `$BF_ROOT/code`); `sudo VAR=value` is
required because `sudo -E` is ignored on that host; a dirty checkout is
refused by design.  Runtime code changes in #2255/#2256 were
scripts/tests only, but the server was still advanced to final main.

## What P-BF-6 Still Needs (Not MC's To Duplicate)

Owner-gated: publish the native release draft `v0.1.0-202611271505-native`
(OPS-1136), then BF-2689 signed-build acceptance (imported bots, real
This Mac turn, clean-profile first bot); BF-2716 (release publish
input, waits for owner yes); BF-2717 recipes only if the owner
activates T9; BF-2444's four product questions before unified Slices
1–2 (Slice 0 iOS view-not-switch needs no new decision).  Claimed by
other seats, help via their topics only: BF-2689, BF-2635 (draft
#2246, needs a workflow-write route), BF-2559, BF-2622, BF-2647,
BF-2527, BF-2678.  BF-2709 (replay families for cursor, gemini-cli,
dsh, opencode) states it is outside P-BF-6 by design; each engine
needs a real transcript adapter and fixtures — do not fabricate them.
iPhone Duo and iPad optimization stay deferred by owner instruction;
scope is iPhone + Mac.  Known honest limits from this session: local
`swift test` was terminated after 34 silent minutes (CI Swift tests
carry that evidence), and Kody produced no completed review receipt
on #2255/#2256 (skipped/incomplete, no findings; Seer findings were
handled).

## Lanes From This Session

`muse-code-bf-2718-info-plist`, `muse-code-bf-2719-tmpdir`,
`muse-code-pbf6-gap-register` (all merged; retire normally),
`muse-code-bf-2711-diskutil` (#2258), `muse-code-fleet-docs-hosted`
(#2259), `muse-code-pbf6-handoff` (this note), plus the pre-existing
`muse-code-pbf6-improve` with 18 unlanded BF-2454/BF-2468 commits —
not touched this session; do not merge it blind.  The integration
checkout root carries ~20 untracked `patch*.cjs`/`fix_*.py` scratch
files (owner property, left untouched).

## Sub-Task Log

- Sat, Nov 28, 1:05 AM — #2255 merged (`67ee1d7e`); BF-2718 closed.
- Sat, Nov 28, 1:07 AM — Server advanced to `67ee1d7e`, bridge
  restarted, harness `ready: true` verified.
- Sat, Nov 28, 1:47 AM — This live handoff note created; BF-2711 PR
  #2258 and BF-2720 PR #2259 in flight as described above.
- Sat, Nov 28, 1:49 AM — Handoff note landed as #2260 (`8f953377`).
- Sat, Nov 28, 2:00 AM — Kody round 1 fixed on #2258 (`5bd5b816a`)
  and #2259 (`fefc3c77b`); all five threads replied and resolved,
  Kody re-requested on both new heads; this update records it.
