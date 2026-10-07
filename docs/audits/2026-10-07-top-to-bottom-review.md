# BotFleet Top-To-Bottom Review

Wed, Oct 7, 2026.  Base: `origin/main` d2bc60257.  Board row `fef4f8e8`.  Seat: Claude.

Seven read-only reviewers covered prior-audit reconciliation, live runtime evidence, server compute, token use and prompting, UX and frontend, bot collaboration, and engineering process.  Each one measured against the live Mac and the current code, and tagged every finding NEW, STILL-OPEN, or REGRESSED against the Sep 24 efficiency audit, the Sep 25 engine audit, and the Sep 27 evaluation, so nothing below re-reports a fixed item as new.  The full reports, with file:line evidence for every claim, are in [`2026-10-07-review/`](2026-10-07-review/).

## Verdict

BotFleet works, and the first fix wave after the Sep 24 audit was real: 46 of 70 prior P0/P1 findings are fixed in code.  But the product is now limited by four things that more features will not solve.

1. **Finishing, not finding, is the bottleneck.**  Eight audits in five weeks filed about 360 findings.  The fix wave closed most P0/P1 items in 36 hours, then stopped.  Three CLAUDE fix branches from Sep 25 were never opened as PRs, about 15 board rows are fixed in code but still "in progress", and since Sep 21 serious rows were created 173 times and resolved 108 times.  The board shows 704 open BotFleet rows, of which 439 are mirrored effort-log entries.
2. **Unattended automation is the cost center, and much of it is noise.**  About 284 unattended webhook turns complete per day.  On the sampled CI thread about half of them conclude "Noise — no action", each one resumed into a thread carrying 132K–472K tokens of old triage history.  The spend ceiling cannot fire because about 97% of turns carry no price.
3. **The data model is append-only JSON and unbounded folders.**  The data directory grew 49% in 13 days to 5.2 GB.  `messages.db` doubled in rows, `routines.json` is 66% copied prompts, 76% of event-log bytes are streamed tokens, and a single search keystroke blocks the harness for 2–7 seconds.
4. **Collaboration primitives lose work silently.**  A bot that hands off work never gets the result back, 29% of handoffs are cancelled because the target was busy, handoffs made from a room are deleted without a trace, and unattended approval cards park a bot indefinitely (76% are never answered).

The host itself is the dominant failure mode today: median swap is 96.7%, and the top error classes are all timeouts waiting on a thrashing machine.  BotFleet's admission gates sit at 98% swap, so they almost never trip.

## How It Is Operating Today

| Area | Measured (Oct 7) |
|---|---|
| Host | 16 GB RAM, swap p50 96.7% (98.3% at sample), load above 20 in 43–63% of samples, disk 92% used |
| Harness | One process, 538–818 MB, one engine child, no orphans.  Running checkout is 4 commits behind main |
| Desktop app | v1.0.31 bundle built from a commit 89 behind main.  Renderer at 42–61% CPU while no bot is working |
| `/health` | p50 42 ms, p95 1.2 s, max 3.5 s.  Carries no commit, version, or boot time |
| Updater | The only release on the feed is v0.1.38, so 1.0.31 installs can never be offered an update |
| Data dir | 5.2 GB, up from 3.5 GB on Sep 24.  `native/` 1.9 GB, `workspaces/` 2.4 GB, `messages.db` 360 MB (118,881 rows), 2,188 TTS clips kept forever |
| Tokens | About 2.2B booked input in 14 days; about 41M per day since Oct 1 (Sep 26 peak 547M).  dsh, grok, mcode, and Antigravity carry over 99% of turns.  The Claude engine ran 117 turns and 115 failed |
| Automation | 21 routines; 2,001 retained runs cover only 62.7 hours; 60% of runs never completed; one routine failed 490 times in 8 hours without tripping the breaker |
| Top errors (7 days) | `session/prompt timed out` 96, ACP init timeouts 56, no-output stalls 35 |
| CI | Push-to-main green 8 of 8 since Oct 6; 43% of all runs cancelled; PR median 36 min, p90 154 min |
| Code | `server/index.ts` 15,955 lines (+37% in 13 days), touched by 30% of commits.  `docs/EFFORT-LOG.md` 750 KB, touched by 46% of commits |

## Course Corrections

These are the redirects, ranked by payoff.  Each one cites the findings it resolves.

### 1. Freeze new audits and run a finishing program

Stop filing new audits until the open P0/P1 count falls.  Run one finishing pass instead.

- Land the orphaned fixes first: `claude/engine-classifier` (REC-3, rate limits and 503s misclassified), `claude/engine-claude-codex-stop` (REC-5, Codex Stop reported as a crash), and the uncommitted `acp-idle-usage` lane (REC-4, ACP kills silent builds at 180 seconds).
- Close the roughly 15 rows that are fixed in code (R1 lists them with PRs), merge the 24 duplicate rows the org move created, and fix the stale TestFlight P0 (shipping has succeeded since Oct 2).
- Make closeout merge-triggered: a PR body that names a board row closes it on merge.  A row is never closed with its remainder described in prose.
- Stop mirroring effort-log rows into the board backlog, and auto-release claims with no comment for 7 days (ENG-13).

### 2. Make unattended work cheap, bounded, and pre-filtered

- Decide "noise" before the model does: merge `check_run`, `check_suite`, and `workflow_run` deliveries for the same run, drop non-required checks on non-default branches, and record a skip receipt instead of a turn (TOK-3).  Estimated 15–20% of fleet input.
- Start each CI wake in a small fresh session seeded with the last few verdicts, or roll over by context size (about 150K) instead of 600 messages (TOK-2).  Estimated 50–75% less input per webhook wake.
- Add a per-bot wake budget (for example 20 an hour, burst 5) that folds overflow into the next wake (TOK-9).
- Budget in tokens, not dollars: record context at start and end plus model calls per turn, then enforce a token ceiling and a per-turn cap for the CLI and ACP engines (TOK-4).
- Give unattended approval cards a time limit (deny, end the turn, one summary notice) and add exact-key pre-grants per routine or webhook (COL-4).
- Treat any repeated identical dispatch failure as doomed and hold the routine with a visible reason (RUN-3, RUN-14).

### 3. Budget BotFleet to the machine it actually runs on

The host is saturated as a matter of course, so treat that as the operating condition, not an alert.

- Calibrate admission to the measured distribution instead of 98% swap, and cap concurrent engine starts (RUN-1).
- Make every recurring task back off or be event-driven: the VPS credential sync retrying a deterministic failure every minute, the 30-second quota poller with fsynced writes, the always-armed 500 ms jobs timer, and resource triggers that re-fire every 4 hours while a condition persists (CPU-8, CPU-9, CPU-12, CPU-13, RUN-12).
- Find and stop the idle renderer burn (RUN-13, UX-21).
- Answer `/health` cheaply, and raise the 2-second probe that can kickstart a slow but healthy harness (RUN-17).

### 4. Move append-only data into one bounded store

Every data-growth finding, prior and current, comes from one design choice: event-like data kept in whole-file JSON or unbounded folders.

- Move routine runs, deliveries, and attempts to sqlite, store prompts by reference, and retain by age and per-routine count (RUN-2, CPU-6).
- Stop persisting and broadcasting every streamed token.  Settled items are the record; deltas are ephemeral (CPU-4).  Send clipped previews and deltas over SSE, never whole transcripts (CPU-5).
- Never full-load a thread to answer a one-row question, and bound the thread cache by bytes (CPU-2).  Put search on an FTS5 index or a worker thread (CPU-1, RUN-5).
- Give live threads, `native/`, `events/`, `workspaces/`, and TTS clips a byte budget with oldest-idle-first reclaim (CPU-3, RUN-4, RUN-6, RUN-7).

### 5. Rebuild collaboration around one inbox per bot

- Replace the nine separate "wait for the bot" queues with one saved, ordered inbox per bot: owner first, then handoffs, then automation.  Nothing is cancelled for being busy, nothing expires silently, Stop cancels by origin, and the inbox survives a restart (COL-20, COL-2, COL-7, COL-18).
- Make a handoff a child task with a return path, so the Chief of Staff can actually combine results (COL-1, COL-13, COL-14).  Fix the room handoff that is silently deleted (COL-3).
- Rooms are for people: one lead by default, 2–4 bots, no "everyone" default (the busiest room averages 7.5 bot replies per owner message), and room turns go through the same stop, spend, and quota gates as 1:1 turns (COL-6, COL-9, COL-15).
- Bot-to-bot channels become an audit trail, not unread conversations (COL-10, COL-11).

### 6. Make status legible, with one "Needs You" surface

- Carry the server's typed error code, reset time, and quota state to the UI, and render one plain-language headline with recovery buttons chosen by code, not by substring (UX-1, UX-4).
- Add a permanent "Needs You" list of waiting approvals, questions, errors, and dead bots, with keyboard Allow and Deny, a real command palette, and notification actions.  The phone currently approves faster than the desktop (UX-2, UX-9).
- Mount an app-level error boundary and bound `fromCodePoint`: today one malformed entity blanks the window, and it re-crashes on relaunch (UX-3).
- Cut App Settings from 10 tabs to about 6 (UX-11).

### 7. Send the prompt once, and keep it short

- Port the Claude driver's stable/volatile prompt split to Codex, Pi, Antigravity, and the ACP core, so a resumed session never receives the full system prompt again (TOK-1, board `8b98aacd`).
- Cap inlined MEMORY.md at about 6 KB.  It is 76–86% of every system prompt today, and its "trim it" note costs whole turns (TOK-5).
- Mount only what a wake needs: one computer chosen by the trigger, no duplicate `qdrant_*` recall aliases, no routine-authoring schemas on CI wakes (TOK-7).
- Stop shipping the owner's own specialist names (Compiler, Deployer, Fixer, and others) in the product prompt (TOK-8, COL-16).

### 8. Tier the engines

BotFleet carries about 16 engine drivers, but dsh, grok, mcode, and Antigravity run over 99% of turns, and the Claude engine failed 115 of its last 117 turns.  Every driver multiplies the work in corrections 2 and 7 (prompt split, telemetry, Stop handling, warm sessions, version gates).  Name a Tier 1 set that gets all of that, mark the rest experimental and feature-frozen, and find out why the Claude engine is failing before investing further in it.

### 9. Make "green" and "running" mean something

- Replace the echo-only required "Swift tests + iOS build" context and the no-op control-plane job with one aggregate gate, and get a verdict on the merge commit (strict, per-SHA push groups, or a merge queue) (ENG-1, ENG-2, ENG-4).
- Shard the 14.7-minute serial vitest suite on Ubuntu, run changed tests on PRs, and move macOS and Windows to the merge queue or post-merge (ENG-3, ENG-10).
- Put `sourceCommit`, boot time, and distance from main in `/health`, stamp Sentry releases from `build-identity.json`, and print the Sentry and Infisical boot lines after configuration is applied (RUN-8, RUN-15).

### 10. Cut coordination ceremony for many concurrent seats

- Add a line-count ratchet on `server/index.ts` now, then split the 5,867-line route table into `server/routes/*` (ENG-5, CPU-10).
- Move the effort log out of the hot path: per-day or per-seat files, with the index generated from the board (ENG-6).
- Make the PR the claim, keep Slack for cross-seat handoffs, and run typecheck plus affected tests locally with CI as the authority (R7 course correction 5).
- Add a `Seat:` trailer or label to every PR so per-seat quality and churn can be measured (ENG-12).

## P0 And P1 Findings

| Id | Sev | Tag | Finding |
|---|---|---|---|
| REC-1 | P0 | STILL-OPEN IO21 | Phone companion sidecar dies with the Electron app, so the phone path returns 502s that still page Sentry |
| TOK-1 / REC-2 | P1 | STILL-OPEN | Resumed native sessions get the whole system prompt again every turn (all engines except Claude) |
| TOK-2 | P1 | NEW | Automation rollover counts messages, not context; CI wakes average 132K–472K tokens |
| TOK-3 | P1 | NEW | About half of CI wakes on the sampled thread end in "Noise — no action"; no dedupe across GitHub event types |
| TOK-4 | P1 | STILL-OPEN | ACP telemetry books context as input and never output or cost; spend ceiling cannot fire |
| RUN-1 | P1 | STILL-OPEN | Host saturated; admission gates at 98% sit above the normal operating point |
| RUN-2 | P1 | STILL-OPEN HS4 | Routine run history covers 62.7 hours, 60% of runs never complete, prompts copied into every run |
| CPU-1 | P1 | NEW | `/api/search` is a synchronous full-table scan that blocks the harness for 1.8–7.2 seconds |
| CPU-2 | P1 | STILL-OPEN HS12 | `publicBot` and `wireTask` still full-load threads; 3.2 seconds and +176 MB for one giant thread |
| COL-1 | P1 | NEW | `delegate_bot` results never reach the bot that delegated |
| COL-2 | P1 | STILL-OPEN T5 | 29% of handoffs are cancelled because the target is busy, after the model was told "queued" |
| COL-3 | P1 | NEW | `delegate_bot` from a room member is deleted without a word |
| COL-4 | P1 | NEW | Unattended approval cards hold the bot indefinitely; 24% are ever answered |
| COL-5 | P1 | NEW | Per-turn worktree leases destroy a bot's work (opt-in, off by default, 0 bots use it) |
| COL-6 | P1 | NEW | Room turns skip the bot-stop policy, so a stopped bot still speaks in rooms |
| UX-1 | P1 | NEW | Typed provider errors are dropped; the UI shows raw engine text and picks buttons by substring |
| UX-2 | P1 | NEW | No fleet-wide "Needs You" queue; approvals are per-chat and mouse-only |
| UX-3 | P1 | STILL-OPEN, escalated | One malformed entity blanks the app and re-crashes it on relaunch; no app-level error boundary |
| REC-3 | P1 | STILL-OPEN | Error classifier marks hard quota caps transient and Codex 503s terminal (fix branch exists, no PR) |
| REC-4 | P1 | STILL-OPEN E4 | ACP idle deadline kills silent tool calls such as builds (fix uncommitted in a lane) |
| REC-5 | P1 | STILL-OPEN | Codex Stop settles as a crash and pages Sentry (fix branch exists, no PR) |
| REC-6 / CPU-7 | P1 | STILL-OPEN DR3 | ACP and Codex cold-spawn a fresh CLI every turn |
| REC-8 | P1 | STILL-OPEN | Capability gate half built; failover can pick an engine that cannot run the turn |
| ENG-1 | P1 | NEW | A required check passes with only `echo` and strict checks are off, so green does not mean verified |
| ENG-3 | P1 | STILL-OPEN I3 | 14.7-minute serial test suite runs on three OSes per PR; PR p90 is 154 minutes |
| ENG-5 | P1 | STILL-OPEN A1 | `server/index.ts` is 15,955 lines and touched by 30% of commits |
| ENG-6 | P1 | STILL-OPEN P4 | `docs/EFFORT-LOG.md` is 750 KB, touched by 46% of commits, and lost 707 rows once |

## Notable P2 Findings

- **Security and hygiene:** credential-bearing backups and one-time secret files still sit in the live data directory (RUN-10); the data directory is 0755 and several JSON stores are world-readable (RUN-11); the `renderer-trust` IPC test runs in no CI job (ENG-9); the required `lint` job uses floating action tags (ENG-15); rotation of the webhook secrets that reached Sentry is still unconfirmed (board `f0ac75e6`).
- **Observability:** boot lines say Sentry and Infisical are disabled while Mac events still arrive, with no release tag; CI and the fleet VPS share the production project (RUN-15).  The test-count floor guards only 12% of the suite (ENG-7).  The lint baseline has ratcheted upward three times in nine days to 4,890 (ENG-8).
- **Engines:** launch failures report "isn't installed" for a wrapper that exists (RUN-14); the unattended model downgrade skips grok and dsh, which run the fleet (TOK-6); every ACP wake mounts five tool servers (TOK-7).
- **Collaboration:** the loop breaker silently drops the owner's own messages when they quote a bot (COL-12); handoffs run inside the target's main 1:1 conversation (COL-14); handoffs and `ask_bot` skip the spend ceiling (COL-15); room turns interrupted by a restart vanish (COL-18).
- **UX:** shortcut collisions between the Electron menu and the renderer (UX-8); first run asks for an email before showing value and can dead-end (UX-10); "agent" appears in 33 user-facing strings, 30 of them on iOS (UX-12); clock formatting shows zone abbreviations and follows the OS 24-hour setting (UX-13); the default theme follows the OS and 6 of 10 skins fail the contrast check, which runs nowhere (UX-14); the iOS companion lacks the desktop's wait reasons and ignores Dynamic Type (UX-16).
- **Docs drift:** `docs/architecture/channel-triggers-and-concurrency.md` describes a payload vault, event capsule, and `read_webhook_payload` tool that do not exist (COL-19, TOK-15); AGENTS.md contradicts itself on iOS bundle IDs (ENG-16); the iMessage relay is documented as always-on but is disabled (RUN-19).

## Fix-First Sequence

Small, high-value items first.  Each line names its findings and effort.

| # | Action | Findings | Effort |
|---|---|---|---|
| 1 | Open PRs for the three orphaned CLAUDE engine fixes | REC-3, REC-4, REC-5 | S |
| 2 | App-level error boundary and bounded `fromCodePoint` | UX-3 | S |
| 3 | Room handoff lookup by `fromBotId`; stop policy in room turns; bot channels out of the unread count | COL-3, COL-6, COL-10 | S |
| 4 | CI webhook dedupe pre-filter and per-bot wake budget | TOK-3, TOK-9 | M |
| 5 | Roll automation threads by context size, or fresh session per CI wake | TOK-2 | S |
| 6 | Unattended approval time limit and per-trigger pre-grants | COL-4 | M |
| 7 | Aggregate required gate; delete the no-op control-plane job; per-SHA push groups | ENG-1, ENG-2, ENG-4 | S |
| 8 | Commit, boot time, and distance from main in `/health`; Sentry release tag | RUN-8, RUN-15 | S |
| 9 | Stop teeing `content.delta`; clipped `lastMessage` in SSE frames | CPU-4, CPU-5 | S–M |
| 10 | Generalize the doomed-dispatch breaker; back off the VPS credential sync | RUN-3, RUN-12, CPU-8 | S |
| 11 | FTS5 or worker search; drop full-thread loads from `publicBot` and `wireTask` | CPU-1, CPU-2, RUN-5 | M |
| 12 | Handoff as child task with return path; wait instead of cancel when busy | COL-1, COL-2, COL-14 | M |
| 13 | Stable/volatile prompt split for resumed sessions; MEMORY.md cap | TOK-1, TOK-5 | M |
| 14 | Token-based ceiling and real ACP telemetry | TOK-4 | M |
| 15 | `index.ts` growth ratchet, then route extraction | ENG-5, CPU-10 | S, then L |
| 16 | Shard vitest; Ubuntu-only PR gate; merge queue | ENG-3, ENG-10 | M |
| 17 | Routine runs to sqlite with age retention; TTS TTL; data-dir byte budgets | RUN-2, RUN-6, RUN-7, CPU-3 | M |
| 18 | Typed bot-status contract and "Needs You" surface | UX-1, UX-2, UX-4 | M |
| 19 | Effort log to per-day files; stop mirroring effort rows into the board | ENG-6, ENG-13 | M |
| 20 | One inbox per bot | COL-20 | L |

## Owner Decisions

1. **Three unpushed commits on local `main` in `~/Code/BotFleet`** (`02ed8ad15`, `7661f360a`, `99d018ecd`; 8 UI files, +44/−27).  Origin/main already has the draggable header (#839) and a sanitized per-user Local VM container name.  The commits also revert the fleet's "CUA" copy standard and produce "BotFleet prepares BotFleet and the VM for you".  Recommendation: discard them.  They were left untouched.
2. **Updater feed.**  Cut a transition release so 1.0.x installs can update (a public release, so it needs your approval), or remove the auto-check until one exists (RUN-9).
3. **Webhook secret rotation.**  Confirm the three endpoints whose secrets reached Sentry were rotated, so `f0ac75e6` can close.
4. **Audit freeze and ceremony changes.**  Corrections 1 and 10 change fleet protocol in `AGENT-SYNC.md`, which is yours to approve.
5. **Engine tiering and room defaults.**  Which engines are Tier 1, and whether "everyone" rooms stop being a default (corrections 5 and 8).

## Fixed Since Prior Audits

Of 70 prior P0/P1 rows across the Sep 24 and Sep 25 audits: 46 fixed, 11 partial, 12 open, 1 regressed (worktree count tripled from 24 to 72).  Highlights that hold up in code and on the live Mac: APNs flood and breaker (#597, #614), async log redaction (#598, #600), atomic and debounced JSON writes (#636), early listen and SIGTERM interrupt recording (#634), bounded `read_file`, code splitting and lazy telemetry in the renderer (#613), separate stream context for token deltas, `webhooks.json` down from 3.0 MB to 0.75 MB, `routines.json` down from 35.7 MB to 6.2 MB, no orphaned engine processes, and iOS shipping again since Oct 2.  The per-audit status tables are in [R1](2026-10-07-review/R1-reconciliation.md).

## Reports

| Report | Scope | Findings |
|---|---|---|
| [R1 Reconciliation](2026-10-07-review/R1-reconciliation.md) | Prior audit status, board health, audit cadence | 8 |
| [R2 Runtime](2026-10-07-review/R2-runtime.md) | Live processes, data dir, logs, Sentry, CI | 19 |
| [R3 Server Compute](2026-10-07-review/R3-server-compute.md) | Timers, persistence, event loop, SSE, `index.ts` map | 16 |
| [R4 Tokens And Prompting](2026-10-07-review/R4-tokens-prompting.md) | Prompt assembly, caching, wakes, telemetry, routing | 15 |
| [R5 UX And Frontend](2026-10-07-review/R5-ux-frontend.md) | Navigation, status, onboarding, copy, a11y, render cost, iOS | 22 |
| [R6 Collaboration](2026-10-07-review/R6-collaboration.md) | Rooms, handoffs, approvals, queues, recovery | 20 |
| [R7 Process And CI](2026-10-07-review/R7-process-ci.md) | CI health, PR flow, tests, docs, churn | 16 |

Method limits: the Mac was under heavy load (load average 32–112) during measurement, so timings are loaded-Mac numbers.  Render costs in R5 are inferred from code, not profiled.  Token savings are estimates from one or a few threads and should be checked with the measurements each correction names.
