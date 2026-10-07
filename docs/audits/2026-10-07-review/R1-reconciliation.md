# R1 Reconciliation (2026-10-07, origin/main d2bc60257)

Evidence form: `PR #n; file symbol`.  Status tags: FIXED, PARTIAL, OPEN, REGRESSED.  FIXED* means the audited defect is fixed and a lower-severity residual remains.

## Method Notes

- Code was read at HEAD.  The classifier claims were executed with `node --experimental-strip-types` against `server/drivers/retry.ts`.
- Board rows come from `board list --app botfleet --json`.  `updated_at` stands in for resolution date, and resyncs touch it.
- Sep 27 evaluation IDs (E, C, M, R) are cited only where they corroborate or downgrade a finding.

## Status Table: 2026-09-24 Efficiency Audit

P0 rows:

| id | title | sev | status | evidence |
|---|---|---|---|---|
| IO1 | APNs transport log flood | P0 | FIXED | #597; `apns.ts` per-device `firstTime` keying |
| IO2 | key-fault latch not persisted | P0 | FIXED | #597; `index.ts:186` `diskKeyFaultStore`; `apns.ts:1857` load; #614 `PushSenderHealth` |
| IO10 | iOS Sentry pages on 5xx | P0 | PARTIAL | #579; `CompanionGatewayFailurePolicy.swift` suppresses only 530 with cf-error 1033, an owner ruling.  Residual P2 (eval M1) |
| IO21 | sidecar dies with Electron | P0 | OPEN | no companion plist; `electron/companion.mjs` still spawns it; see REC-1 |
| HS1 | transcripts never reclaimed | P0 | PARTIAL | #599; `sweepOrphanedTranscripts`; live idle threads skipped at `transcript-retention.ts:587`.  Residual P2 (C10) |
| HS10 | sync redaction and tee | P0 | FIXED | #598 #600; `bus.ts:71` async queue; `shared/redact.ts` `LOG_TEE_MAX_STRING_CHARS` (256 KB) |
| HS18 | SIGTERM looks like a crash | P0 | FIXED | #634; `boot-recovery.ts` records interrupts, stagger 2 s, concurrency 3, total cap |

P1 rows:

| id | title | sev | status | evidence |
|---|---|---|---|---|
| DR1 | roster busts Claude reuse | P1 | FIXED* | #617 #635; `chief-of-staff.ts:81`.  Residual P3 (E24) |
| DR2 | no engine retry | P1 | FIXED* | #617; `acp/core.ts:36`, `antigravity.ts:50`.  `pi.ts` and `cli-wrapper.ts` have none |
| DR3 | ACP and Codex cold-spawn | P1 | OPEN | no warm-session code; REC-6 |
| DR4 | Antigravity global mutex | P1 | PARTIAL | #617; `antigravity.ts:222-262` reader/writer lease; `TODO(DR4)` remains; `:876` any integration takes the exclusive side |
| DR5 | unbounded `read_file` | P1 | FIXED | #617; `tools/computer.ts:42` `READ_FILE_MAX_BYTES` 64 KB |
| IO1b | breaker never opens | P1 | FIXED | #597; per-device `recordError`, `isTransportFailure` includes http2 |
| IO3 | open circuit drops alerts | P1 | FIXED | #597; `apns.ts:2055` defer path |
| IO4 | dedupe key grows | P1 | FIXED | #597; `firstTime` keys |
| IO5 | phone drops breaker state | P1 | FIXED | #614; `PushSenderHealth.swift:38-51` |
| IO11 | reconnect no jitter | P1 | FIXED* | #614; `ReconnectBackoff.swift`.  Residual P2 (M2) |
| IO12 | hydrate wipes scrollback | P1 | FIXED | #614; `Store.swift` `hydrate` merges pages |
| IO13 | foreground double hydrate | P1 | FIXED* | #614; `Session.swift:1452`.  Residual P2 (M3) |
| IO18 | streaming republishes state | P1 | OPEN | `Session.swift:48` `@Published state`; `Store.swift:481` |
| IO19 | roster recompute in body | P1 | OPEN | `ChatListView.swift:553-667`; `Store.swift:185` |
| IO22 | Worker on wrong host | P1 | FIXED | #657 deleted the Worker config |
| IO26 | "unread Live Activities" | P1 | OPEN | `LiveActivities.swift:222` `pushType: nil`; issue #294 open as P3 |
| OP1 | packaged Sentry cannot load | P1 | FIXED | #580; `bundle-server.mjs:43` `createRequire` banner |
| OP2 | telemetry outbox 409 | P1 | FIXED | #581; `telemetry-outbox.ts:27` terminal statuses include 409 |
| OP3 | quota poller no backoff | P1 | FIXED | #618; `antigravity-quota.ts:300` ceiling, `:337` streak |
| OP4 | cloudflared fetch | P1 | FIXED | #616; `prepare-cloudflared.mjs` 3 attempts, 10 min |
| OP5 | host updater wrapper stale | P1 | FIXED* | `~/apps/update-botfleet.sh:166` has the bootstrap block; copy is 345 lines against 425 tracked |
| OP6 | resource-watch silence | P1 | OPEN | `~/apps/mac-resource-watch.py:45-52` no ceiling or escalation; no commit |
| UI1 | idle mascot rAF loops | P1 | FIXED* | #613; `ChatView.tsx:544,783,810,908` `animated={false}`.  Residual P3 (R17) |
| UI2 | no code splitting | P1 | FIXED | #613; `App.tsx:28` `lazy(` |
| UI3 | Sentry and PostHog eager | P1 | FIXED | #613; `sentry.ts:67`, `analytics.ts:31` dynamic import |
| HS2 | `messages.db` no prune or vacuum | P1 | PARTIAL | #599; `message-db.ts:44`.  Live DB reports `auto_vacuum=0`, so INCREMENTAL never applies.  Freelist 0 |
| HS3 | stale workspaces | P1 | FIXED | #599; workspace dirs 103 to 21 (`ls ~/.botfleet/workspaces`) |
| HS4, HS5, HS6 | whole-file JSON writes | P1 | FIXED | #636; `writeFileAtomic` plus debounce in `store.ts`, `routines.ts`, `webhooks.ts:158`.  No raw `writeFileSync` remains |
| HS11 | boot reads 16 MB files | P1 | FIXED | #598; `rolling-spend.ts` inode cursor stream |
| HS12, HS21 | unbounded thread cache | P1 | FIXED | #602; `store.ts:844` LRU 64; `index.ts:2321` `messagePage` uses `messagesTail` |
| HS19 | port opens late | P1 | FIXED | #634; `index.ts:524` `let booting = true`; `:576` early listen |
| HS24 | checkpoint snapshot, no gc | P1 | OPEN | `checkpoints.ts:130-132` `gc.auto = 0`; no prune; file untouched.  Eval C11 P2 |
| RH1 | worktree sprawl | P1 | REGRESSED | REC-7 |

Count: 43 rows.  FIXED 31 (including FIXED*), PARTIAL 4, OPEN 7, REGRESSED 1.

## Status Table: 2026-09-25 Engine Audit

P0 rows:

| id | title | sev | status | evidence |
|---|---|---|---|---|
| P0-1 | resumed sessions re-inline system prompt | P0 | OPEN | `pi.ts:932`, `codex.ts:304`, `antigravity.ts:799`, `acp/core.ts:1663`; REC-2 |
| P0-2 | DSH/MiniMax-M3 effort and options | P0 | FIXED | #518; #769 per-model levels via Clutch #65.  Code-side only.  Plain M3 `max` unverified; eval E11 listed the effort half open on Sep 27 |
| P0-3 | Antigravity always-proceed paging | P0 | FIXED | #646 `EXPECTED_TURN_STOPS`; code-side only, live recurrence not verified |
| P0-4 | 502/504/530 gateway errors | P0 | PARTIAL | #579 #614; root cause is IO21 |
| P0-5 | whsec secrets reach Sentry | P0 | FIXED | #646 `scrubWebhookSecrets`.  Owner follow-up tracked on the board |

P1 rows:

| id | title | sev | status | evidence |
|---|---|---|---|---|
| P1-1 | no pre-dispatch capability gate | P1 | PARTIAL | #683 `doomed-dispatch.ts` is a reactive breaker; no `capability-profile.ts`; REC-8 |
| P1-2 | failover ignores capability | P1 | PARTIAL | `turn-safety.ts:407` filters computer reach only; images and coding unfiltered |
| P1-3 | routine receipted before failover | P1 | FIXED | #680; `routines.ts:1516` `fallingOver`; `index.ts:4193,4316` `runOn` passed |
| P1-4 | no minimum-CLI-version gate | P1 | OPEN | only DSH via Clutch; eval E23 P3 |
| P1-5 | native tee redacts sync | P1 | FIXED | #648; `native.ts:9-24` |
| P1-6 | replay window slides per turn | P1 | OPEN | `turn-context.ts:57` 128 KB window, no hysteresis; eval E18 P2 |
| P1-7 | transient before terminal | P1 | OPEN | `retry.ts:184-189`; REC-3 |
| P1-8 | Antigravity retry deadline | P1 | FIXED | #647; `antigravity.ts:1028` |
| P1-9 | classifyError shape and "unexpected status" | P1 | PARTIAL | 93b3b20de unified order; `retry.ts:111` still terminal; REC-3 |
| P1-10 | Antigravity 10-min relaunch | P1 | FIXED | #647 |
| P1-11 | pi `set_model` leak | P1 | FIXED | #645 |
| P1-12 | pi stderr unread | P1 | FIXED | #645 |
| P1-13 | pi swallows `switch_session` | P1 | FIXED | #645; `pi.ts:864-889` |
| P1-14 | Grok 120 s abort race | P1 | FIXED | #648; `grok.ts:119-125` |
| P1-15 | Stop settles `exit_before_result` | P1 | PARTIAL | Claude `claude.ts:1925` and Antigravity fixed; Codex not (inferred); REC-5 |
| P1-16 | ACP idle deadline not tool-aware | P1 | OPEN | `acp/core.ts:363`; REC-4 |
| P1-17 | Sentry grouping collapses | P1 | FIXED | #646 per-provider fingerprints |
| P1-18 | Stop pages Sentry (BOTFLEET-R) | P1 | PARTIAL | Claude fixed; Codex inferred open |
| P1-19 | Claude close handler holds turn 1 | P1 | FIXED | #680 (title is unrelated); `claude.ts:1842` `liveTurn = session.turn` |
| P1-20 | setup spawn failures bare | P1 | FIXED | #646 `setupErrorTurns` |
| P1-21 | ACP `session/new` timeout | P1 | PARTIAL | grouping fixed by #646; `core.ts:353` still fixed 120 s, no detail; eval E9 P2 |
| P1-22 | ACP drops cached tokens and cost | P1 | FIXED | #683; `core.ts:1694-1720` |

Count: 27 rows.  FIXED 15, PARTIAL 7, OPEN 5.

Combined: 70 rows.  FIXED 46 (66%), PARTIAL 11, OPEN 12, REGRESSED 1.  Shared defects counted once in the headline: HS10 with P1-5, DR3 with the engine cold-spawn P2, IO21 with P0-4.

Eval's own P0/P1 (17 rows, 7 withheld): E3 FIXED by #680, E4 OPEN, E5 PARTIAL, I1 shipped after Oct 2.  For R2, D3, G16, G28 I found no merged subject naming them; unverified.

## Board Health

Pull: `board list --app botfleet --status open,in_progress --json`, 704 rows.

| kind | open | in_progress | total |
|---|---|---|---|
| agent-report | 78 | 101 | 179 |
| effort-row | 294 | 145 | 439 |
| github-issue | 70 | 0 | 70 |
| review-finding | 8 | 8 | 16 |

By severity (open + in_progress): P0 6, P1 66, P2 94, P3 35, none 503.  No severity is stored for GitHub issues or effort rows, so `--severity P0,P1` filters miss them.  Example: #390 is titled "[P0]" and no `--severity` filter returns it.

P0 rows (6):

- `6d7da479`: decision row, owner or seat input needed.
- `390a2f45`: TestFlight dead.  `gh run view` on `ios-ship.yml` shows the ship step succeeded on Oct 2 23:16Z, Oct 3 03:53Z, Oct 3 17:30Z, Oct 5 01:44Z, Oct 6 01:03Z and Oct 6 05:34Z.  The row is stale.  The iOS fixes #597 and #614 are therefore delivered.
- `8b98aacd`: REC-2, status open, no owner.
- `f0ac75e6`: whsec.  Code fixed by #646; owner follow-up tracked on the board.
- `468b8719`: HS18, code fixed by #634 on Sep 25, row still in_progress.
- `bac463c4`: IO21, REC-1.

Ten oldest open P0/P1 rows (age from `created_at`, as of Oct 7):

| id | age | title |
|---|---|---|
| `9ef14d2b` | 16 d | latest-mac.yml missing, auto-update 404 |
| `5b1f4400` | 16 d | open PR strategy review |
| `a3483a9e` | 16 d | agents.botfleet.app 502 (duplicate of `bac463c4`) |
| `c6858d66` | 15 d | voice cloning pipeline |
| `c01901af` | 12 d | fleet recall degraded readiness |
| `6661ceea` | 12 d | update Mac checkout after work drains |
| `8b98aacd` | 11 d | resumed-session prompt (REC-2) |
| `f26ca0cb` | 6 d | iOS app record missing |
| `232bc316` | 6 d | Deployer thread wedged 10 h |
| `9007ed29` | 6 d | host CPU saturation |

The oldest in_progress P1 is `f5abf14d`, a 36-day-old "top-to-bottom audit" (issue #22).  The Sep 27 eval said to close #22, and it is still open.

Stale claims: 75 of 254 in_progress rows (29%) have no update for more than 7 days.  Twenty-two are P0/P1.  The longest are `f5abf14d` (36 d), `5a2b2e02` (22 d), `3bfa4c2c` (21 d), `151387ee` (20 d), and the CLAUDE rows `da75e2da`, `468b8719`, `bac463c4`, `0257906a`, `a41274f7`, `43106963`, `f0ac75e6`, `c60f5b45`, `4b6f4543` and `165491be`.

Fix program row `ae1eacd7`:

- It is an effort-row with status `open`, though its text says "IN PROGRESS".
- `updated_at` is Oct 4 21:17Z.  It promised "this row is updated as they merge", and it was not.
- Of its 18 child rows, 13 are completed and 5 are in_progress.  The 13 were closed within about 4 minutes on Sep 25 (05:33 to 05:34).
- I spot-checked six of them in code.  Four hold.  `9e024637` closed DR1 and DR4 as "Landed in #617", but `antigravity.ts` carries `TODO(DR4)`.  `80071e15` closed IO10, and its resolution admits "render half in flight on claude/fix-ios-perf", which never existed.  `090d92d9` closed DR2 and DR3, and DR3 lives only on row `8613c983`, a P2 titled "Delegation to a busy peer dead-ends…".
- Of the 5 in_progress children: `468b8719` and `43106963` are done in code (#634, #636).  `a41274f7` is half done (OP10 landed in #616; OP6 is open).  `bac463c4` is open.  `0257906a` is REC-7.

Board versus code (rows that name finished work):

- **Fixed in code, row still in_progress:** `468b8719` (#634), `43106963` (#636), `165491be` (#648), `4b6f4543` (#645), `f0ac75e6` (#646, owner follow-up pending), `390a2f45` (ship succeeds since Oct 2).
- **Fixed in code, row still in_progress, Oct 5-6 merges:** `db59843a` (#877), `eb6d43e0` and `221ca966` (#879), `f9f4852a` (#870), `8f022c06` (#837), `e6715893` (#886), `fb55a6f1` (#759), `5a3344ec` (#883), `1e6f1652` (#860, #898).  I confirmed them by PR title only.
- **Superseded, row still open:** `711449e5` and `2106abbc` (gitleaks licence).  #805 replaced the licensed action with the CLI on Oct 2.

Duplicates:

- Sidecar 502: `a3483a9e` (open) and `bac463c4` (in_progress).
- Updater feed: `9ef14d2b`, `5a2b2e02` and issue #285.
- Gitleaks licence: `711449e5` and `2106abbc`.
- Updater smoke and immutable-release work: `3f98ab8e`, `49465fcb`, `34c834f1`, `f1482275`, `1f3fe835`, `201e6c73`, `6d7da479`.  PR #842 and #858 merged Oct 5 and 6.
- Org move: 24 GitHub issue numbers appear twice, once under `jaywedgeworth22/BotFleet` and once under `Simple-With-Us/BotFleet`.  The old-repo rows for #571 and #572 stay open although both issues are CLOSED on GitHub.
- Closeouts not done since the Sep 27 eval: #531, #567, #575 and #22 are still OPEN.

## Audit Cadence

`docs/audits/` holds 32 files, about 978 KB.  Seven days of work from Sep 24 to Sep 30 account for about 677 KB (69%).  Only four of those are defect audits.  The rest are borrow and framework reviews.

| doc (by filename date) | size | findings filed | state |
|---|---|---|---|
| 2026-09-09 findings | 47.6 KB | 35 | pre-window |
| 2026-09-24 efficiency | 65.7 KB | 97 (7 P0, 36 P1) | 31 of 43 P0/P1 FIXED |
| 2026-09-24 token and performance | 9.8 KB | not counted | merged into #543 |
| 2026-09-25 engine findings | 94.1 KB | 46 (5 P0, 22 P1) | 15 of 27 P0/P1 FIXED |
| 2026-09-25 hardening plan | 37.7 KB | plan | partly executed |
| 2026-09-27 evaluation | 117.7 KB | 215 (2 P0, 15 P1) | says 82 prior fixed, 15 partial |
| 2026-09-29 to 09-30 reviews (framework, Cherry Studio, DeepSeek) | about 316 KB | n/a | borrow reviews |

No audit-class document has landed since Sep 30.

Throughput, P0/P1 rows only (`created_at` against `updated_at` of non-open rows; `updated_at` is a proxy because resyncs touch it):

| week of | created | resolved |
|---|---|---|
| Aug 31 | 67 | 63 |
| Sep 7 | 64 | 57 |
| Sep 14 | 17 | 33 |
| Sep 21 | 59 | 30 |
| Sep 28 | 87 | 52 |
| Oct 5 | 27 | 26 |

Parity through Sep 14 (148 created, 153 resolved).  Since Sep 21, 173 created and 108 resolved.

The first fix wave was fast: #597 through #618 merged on Sep 24 and #634 and #636 on Sep 25.  Then it stopped.  Afterwards only incidental fixes landed (#680, #683, #687, 93b3b20de).  The seven OPEN P0/P1 efficiency items and four OPEN engine P1 items are the tail that stalled.  Audit volume is not what outran fixes.  The merge and closeout step is.

## Findings (STILL-OPEN or REGRESSED)

### REC-1 [P0] [STILL-OPEN] IO21 and engine P0-4: sidecar still dies with Electron
- Evidence: `electron/companion.mjs` spawns the sidecar as a child; `ls ~/Library/LaunchAgents` shows only `app.botfleet.server.plist`.  No commit has touched `companion/` or `electron/managed-companion-*` for this since #634.  Rows `bac463c4` (12 d stale) and `a3483a9e` (16 d, open) duplicate each other.  Eval M4 counted 154 hosted 502s in 14 days.
- Impact: every time BotFleet.app is closed or updating, the phone path returns 502 or 530.  The iOS Sentry filter covers only 530/1033, so 502s still page.
- Recommendation: ship the interim "Mac offline" status first, then move the guardian and origin socket under a LaunchAgent.  Merge the two board rows.  (Effort: L)

### REC-2 [P1] [STILL-OPEN] Engine P0-1: resumed native sessions re-inline the full system prompt
- Evidence: `pi.ts:932`, `codex.ts:304` and `:841`, `antigravity.ts:799`, `acp/core.ts:1663` all send `${turn.system}\n\n${turn.text}` after a resume.  `prompt-split.ts:16` records "Codex and the ACP engines still send the whole prompt".  Row `8b98aacd` is open with no owner for 11 days.
- Impact: each turn adds another 1.5K to 8K tokens to the engine's saved conversation on 12 or more engines.  Audit rated it P0 and the eval downgraded it to P2 (E1, "waste, not breakage").  I grade it P1: the cost is real and quadratic, but nothing breaks.  #883 caps ACP prompts per turn, which limits the growth but does not stop duplication.
- Recommendation: port Claude's receipt scheme from `claude.ts`: send the stable half once per native session and the volatile note only when its digest changes.  (Effort: M)

### REC-3 [P1] [STILL-OPEN] Engine P1-7 and P1-9: classifier verdicts still wrong
- Evidence: I ran `classifyError` on HEAD.  `"Rate limit reached for your plan"` returns `{transient:true, reason:"rate_limited"}` in both shapes, and `"RESOURCE_EXHAUSTED: capacity exceeded"` returns `overloaded`, so hard quota caps still relaunch.  `new Error("unexpected status 503")` and `"unexpected status 500"` return `{transient:false, reason:"invalid_request"}`.  `retry.ts:111` still carries `unexpected status`.
- Impact: a real Codex 503 or 429 on `thread/resume` is terminal, and quota caps burn two cold-boot relaunches.  Commit 93b3b20de made shapes agree but kept the wrong order.
- Recommendation: land branch `claude/engine-classifier` (commit c2a12cbb7), which does exactly this and has not been opened as a PR.  (Effort: S)

### REC-4 [P1] [STILL-OPEN] E4: ACP idle deadline kills silent tool calls
- Evidence: `acp/core.ts:363` `DEFAULT_PROMPT_IDLE_MS = 180_000`; the doc at `:176-181` says it fires after 180 s with no inbound traffic and never looks at open tool calls.  The eval reproduced a silent `pnpm build` killed at the deadline.  Lane `~/apps/botfleet-claude-eng-acp-idle-usage` is 245 commits behind main with uncommitted edits to `core.ts` and `contracts.ts`.
- Impact: builds and test runs on ACP engines die and clear the resume cursor.
- Recommendation: track open tool calls and use the 20-minute window while one is open; commit and PR the lane.  (Effort: S)

### REC-5 [P1] [STILL-OPEN, inferred] Codex Stop settles as a crash
- Evidence: `codex.ts:411-414` `stop()` sets `stopRequested` and kills the child; the close handler at `:759-770` emits `runtime.error` and `exit_before_result` when the turn is unsettled, and never reads `stopRequested`.  Claude (`claude.ts:1925`) and Antigravity (#647) were fixed.  I did not execute it.  Branch `claude/engine-claude-codex-stop` (9ef22275d, 5fc741e48) has no PR.
- Impact: every user Stop on Codex pages Sentry as a crash.
- Recommendation: settle `false, "interrupted"` with no `runtime.error` when `stopRequested`.  (Effort: S)

### REC-6 [P1] [STILL-OPEN] DR3: non-Claude CLI engines cold-spawn every turn
- Evidence: no warm-session code in `acp/core.ts` or `codex.ts`.  The only tracking is row `8613c983`, a P2 titled "Delegation to a busy peer dead-ends…", which does not name DR3.  Eval E17 P2.
- Impact: long threads pay minutes before the model starts, and with REC-2 the history is replayed too.
- Recommendation: file DR3 under its own row, then verify per CLI whether a kept-alive stdio session is possible.  (Effort: L)

### REC-7 [P2] [REGRESSED] RH1: worktree count tripled
- Evidence: `git worktree list` shows 72 entries (65 under `~/apps`), against 24 on Sep 24.  Of the 65 under `~/apps`, 12 have a real `node_modules`, 14 are symlinks and 39 have none.  Sep 24 had 10 real `node_modules`.  Disk free is 32 GiB against 12 GB (`df /`).  Swap is 31.8 of 32 GB used and load was 112 at pull time.
- Impact: node_modules weight improved through symlink lanes; worktree count did not.  Row `0257906a` is in_progress 12 days stale.  I did not run `du` on lanes, so the roughly 25 GB figure for 12 real directories is inferred.
- Recommendation: enforce the symlink-lane rule in lane creation, and prune merged lanes.  (Effort: S)

### REC-8 [P1] [STILL-OPEN] Engine P1-1 and P1-2: capability gate is half built
- Evidence: `doomed-dispatch.ts` (#683) opens after three consecutive setup-class failures; there is no `capability-profile.ts`.  `turn-safety.ts:407` filters failover on computer reach only; `images` and `toolLoop` are declared at `:340-342` and never read.  Eval E5 P1 still open.
- Impact: a turn that needs images or coding can fail over to an engine that cannot run it, spending a billed turn.
- Recommendation: finish board row `5fc628cb` (11 d stale).  (Effort: M)

### Residual items now P2 or P3 (kept out of the P0/P1 count)

- IO18, IO19 (audit P1, eval M7 P2): no board row, branch `claude/fix-ios-perf` does not exist.
- HS24 checkpoint gc: no board row (eval C11 P2).
- OP6 resource-watch silence: named on `a41274f7`, no design.
- IO26: issue #294 is P3.
- Engine P1-4 minimum-CLI-version gate (eval E23 P3), P1-6 replay hysteresis (E18 P2), P1-21 `session/new` detail (E9 P2): no board rows.
- HS1, HS2: data dir is 5.2 GB against 3.5 GB (`native` 1.9 GB, `workspaces` 2.4 GB of which one 2.0 GB live workspace, `messages.db` 360 MB and 118,885 rows against 58,532).  The growth is live data.
- DR4: exclusive lease still taken on any non-empty integrations map; eval E10 asserts the agents MCP server mounts on every depth-0 turn, which I did not confirm.
- Main CI: `gh run list --workflow ci.yml --branch main` returns its newest run on Sep 17; board rows `098d00c7` and `68d156d4` (P1, open 5 d) say the required gate produces no verdicts.  This is a lead, not verified here.

## Fixed Since Prior Audits

See the two status tables above.  The 46 FIXED rows are listed there with their PRs.

## Course Corrections

1. **Open the PR before moving on.**  Two engine fix branches were pushed on Sep 25 with no PR (`claude/engine-classifier` 1 commit, `claude/engine-claude-codex-stop` 2 commits).  One lane (`acp-idle-usage`) has uncommitted edits.  `claude/engine-status-truth-epoch-followup` has 25 unmerged commits, and `claude/slash-server` has 2.  All sit 137 to 245 commits behind main.  A fix not merged is a finding still open.
2. **Do not close a row with its remainder in prose.**  `80071e15` closed IO10 while naming a branch that was never created.  `9e024637` closed DR4 over a live `TODO(DR4)`.  `090d92d9` hid DR3 under a P2 row.  One row per outstanding half would have kept them visible.
3. **Make severity and links survive the sync.**  GitHub issue rows carry no severity, so `--severity` filters skip #390.  The org move created 24 duplicate rows and left #571 and #572 open on the board while closed on GitHub.  A closeout checklist for the Sep 27 "close, citing the fix" list (#531, #567, #575, #22) has not been run in 10 days.
4. **Replace the end-of-wave closeout sweep.**  Five fixed-in-code rows (`468b8719`, `43106963`, `165491be`, `4b6f4543`, `390a2f45`) and about ten Oct 5-6 rows are still in_progress.  A merge-triggered closeout comment from the PR body would cost less than a reconciliation audit every two weeks.
5. **Pause new audits until the open P0/P1 count falls.**  Four defect audits in seven days filed about 358 findings; the fix wave closed most P0/P1 in 36 hours, then stopped.  Seventeen open P0/P1 rows and 55 in-progress ones are older than any new report.  Another audit adds reading, not fixes, until REC-1 through REC-6 have merged PRs.

Key files: `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/docs/audits/2026-09-24-efficiency-audit.md`, `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/docs/audits/2026-09-25-engine-audit-findings.md`, `/Users/jay/Code/BotFleet/.claude/worktrees/app-review-optimization-733c14/docs/audits/2026-09-27-botfleet-evaluation.md`.
