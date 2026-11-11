# R3 Server Compute And Resource Efficiency (prefix CPU)

Base: `origin/main` d2bc60257.  Read-only.  Timings used read-only `node:sqlite` handles or in-memory micro-benchmarks, with the load average at 32 to 104 during my runs (`uptime`).  Treat them as loaded-Mac numbers.  "Extrapolated" and "inferred" are labelled.

## Findings

### CPU-1 [P1] [NEW] `/api/search` is a synchronous full-table scan on the main thread
- Evidence: `server/message-db.ts:385-399` runs `lower(text) LIKE` plus `json_extract(json,'$.tool.name')` over every row.  The comment says "megabytes at most, a scan is milliseconds", but `messages.db` is 360 MB and 118,885 rows (178 MB of JSON, 70,538 of them `activity` rows).
- I ran the same SQL read-only.  Four runs took 3,868, 1,809, 4,626 and 7,219 ms (the last was a no-hit query).  The handle is `DatabaseSync`, so the harness event loop stalls for that long.
- Callers: `CommandPalette.tsx:64-69` (150 ms debounce) and `ChatFindBar.tsx:33-45` (180 ms debounce).  `index.ts:10686-10690` then calls `store.activePath()` on each hit thread, which fully loads it (see CPU-2).
- Impact: each typed query freezes health, SSE and every bot's streaming for seconds.  This is the same wedge class as the Sep 12 `routines.json` incident.
- Recommendation: add a real `tool_name` column and an FTS5 index, or run search on a `worker_threads` read-only connection.  Cap the scan by recency.  Delete the false comment.  (Effort: M)

### CPU-2 [P1] [STILL-OPEN HS12/HS21] The bounded-hydrate fix is bypassed, so full threads still load
- Evidence:
  - `publicBot` (`index.ts:2169-2173`) calls `store.messagesFor(bot.threadId)`.  `GET /api/bots` (`:10530`) only spreads the slim `messagePage` over the result afterwards.
  - `wireTask` (`:2136-2147`) calls `store.messagesFor(task.threadId).at(-1)` for every task.  It runs on every hydrate, and on every `bot` broadcast via `store.onChange` (`:2259-2261`).
  - `messagesFor` on a miss is a full `readThread` (`store.ts:1647-1653`).  The cache is 64 entries by count (`store.ts:844`).
- The bot-side set is 73 distinct threads (12 main threads are also tasks), holding 114,542 rows and 174.6 MB of JSON.  73 is more than 64, so a sequential pass thrashes the LRU.
- Measured loads of single threads (`SELECT json … ORDER BY rowid` plus `JSON.parse`):

| Thread | Messages | Parse time | Retained heap after GC |
|---|---|---|---|
| Compiler task | 32,799 | 3,175 ms (97 µs each) | +176 MB |
| Designer | 12,341 | 717 ms | +229 MB cumulative |
| The five largest together | 72,569 | about 4.6 s | +261 MB (transient peak +511 MB) |

- A bounded `LIMIT 51` read of the same thread took 1.6 ms.
- Extrapolated cost of one all-miss hydrate: 114.5k rows × 60 to 100 µs, which is about 7 to 11 s of blocked loop.  A cold `appendMessage` or `activePath` on a giant thread also pays 3 s or more.
- Impact: this is the likely main contributor to the 542 MB harness RSS (live, `top -pid`).  That link is inferred, since I took no heap snapshot.
- The desktop `reconcile` path (`src/state/store.tsx:2400`) calls `/api/bots` with no `messages=`.  It only runs after a rejected PATCH, so it is rare.
- Recommendation: drop `messages` from `publicBot` when paging.  Store `lastActivity` and a clipped `lastMessage` on the task record, or read it with `ORDER BY rowid DESC LIMIT 1`.  Make `ThreadCache` byte-weighted.  (Effort: M)

### CPU-3 [P2] [STILL-OPEN HS1/HS2/HS3] Retention sweeps handle dead things, but live growth is unbounded
- The mechanisms exist: `index.ts:725` and `:2087` for transcripts, `:2091-2128` for workspaces and `pruneDeadThreads`.  Growth since Sep 24 is 1.7 GB in 13 days:

| Item | Sep 24 | Now |
|---|---|---|
| `~/.botfleet` | 3.5 GB | 5.2 GB |
| `messages.db` | 251 MB | 360 MB |
| `messages.db` rows | 58.5k | 118.9k |
| `native/` | 1.2 GB | 1.9 GB (13 files at the 64 MB cap) |
| `events/` | 143 MB | 315 MB |
| `workspaces/` | 1.9 GB | 2.4 GB |
| `*bak*` files | 36 | 44 |

- The five giant tasks (Compiler, Fixer, Designer, Deployer, Housekeeper) hold 143 of 178 MB of JSON.  They have no `automationKey`, so they are legacy pre-rollover threads that are still live.  No sweep ever touches a live thread.
- Rollover works for new keyed tasks.  The largest keyed task is 572 messages and 380 KB, against the 600 cap (`automation-rollover.ts:42`).  The old tasks keep their history by design.
- 10,582 `system` rows (69 MB of 94.6 MB) in the Compiler thread are automation prompts stored whole.  The same prompts are already in `routines.json` runs.
- The live `messages.db` has `auto_vacuum=0`.  The `INCREMENTAL` pragma at `message-db.ts:36-47` only applies to fresh databases.
- Recommendation: add an archive or trim pass for tasks idle longer than N days (keep the last N rows, export the rest).  Store routine prompts by reference rather than copying them into the thread.  Lower the live-thread log caps (CPU-4).  (Effort: M)

### CPU-4 [P2] [NEW] Every streamed token is persisted, and the log is 76% deltas
- Evidence: in the last 8 MB of the busiest events file, 19,541 of 24,216 lines were `content.delta`.  That is 6.09 MB, or 76% of the bytes, at about 311 B per line.
- The Trajectory reader already drops them (`thread-events.ts:556`, `:575`).  Settled text is in `item.completed`.
- Each delta costs:
  - 18 µs of wire redaction (`index.ts:2370-2380`, measured).
  - 9 µs of tee redact plus stringify (`bus.ts:204-228`, measured).
  - One async `appendFile` through a single global FIFO with one write in flight (`append-queue.ts:163-176`, `bus.ts:228`).
  - One SSE frame of about 350 B of envelope for a few bytes of text (`index.ts:3560`).
- Compute per delta is small (about 27 µs), so this is I/O and retention waste, not CPU.  One global writer serialises unrelated threads.  Under swap it drops entries and writes "history incomplete" markers (8 MB cap, `append-queue.ts:33`).
- Recommendation: do not tee deltas, or coalesce them to at least 250 ms.  This frees about 75% of the 16 MB event cap and removes most queue pressure.  Batch SSE deltas per animation frame on the server.  (Effort: S)

### CPU-5 [P2] [NEW] SSE sends full snapshots instead of deltas, and every client gets every bot's events
- Evidence: `wireTask` embeds `lastMessage` in every task of every `{kind:"bot"}` frame.  Computed from the live DB, the frame sizes are:

| Bot | Base | Task metadata | `lastMessage` | Total |
|---|---|---|---|---|
| Housekeeper (14 tasks) | 3.9 KB | 13.8 KB | 55.3 KB | about 73 KB |
| Fixer | 1.7 KB | 10.3 KB | 21.7 KB | about 34 KB |
| All 12 bots | | | 183 KB of `lastMessage` | |

- Each `setActivity` and each `patchBot` emits one (`store.ts:1941-1988`).  I count at least 5 per turn: working, idle, `inflightThreadId` on and off, and the resume cursor.
- The 4 MB `ReplayBuffer` (`index.ts:621`) holds about 55 such frames.
- Four paths broadcast `publicBot(bot)` with the whole active transcript.  They are `createTask`, `activateTask`, `rolloverAutomationTask` and `deliverEphemeralResult` (`index.ts:5892`, `:5899`, `:5918`, `:5947`).  Today the largest active thread is Monitor's, at 3,388 messages and 2.6 MB.  A giant task as the active thread would exceed the 4 MB replay cap and the 8 MB slow-client cutoff.  I did not observe that case.
- There is no per-client thread or bot subscription (`sse-broadcast.ts` `wants()` filters only `screen`).  A phone gets every bot's tokens.
- Recommendation: send a clipped `lastMessage` preview.  Make `bot` frames deltas.  Send transcripts only on the explicit task-switch response.  Add a subscribe-by-bot filter for companions.  (Effort: M)

### CPU-6 [P2] [STILL-OPEN HS4, residual] `routines.json` is still a 6.2 MB whole-file rewrite
- The debounce (250 ms) and the atomic writer are in (`routines.ts:1846-1906`).  What remains is size.
- `routines.json` holds 2,001 runs.  Prompt snapshots are 4.1 of 6.3 MB.  The file is 6,201,971 bytes.
- Timings: `JSON.stringify` took 23 to 28 ms and `JSON.parse` took 30 ms.  `save()` itself runs `retainRoutineRuns` and `boundStalePromptSnapshots` before the debounce, 7.1 ms per call on the real data.
- Rough cost per routine run is at least 5 `save()` calls (35 ms) plus one flush (about 28 ms plus fsync).  That is about 65 ms of main-thread time per run (estimate).
- Recommendation: move runs to an append-only sqlite table, or cap by bytes (about 1,000 runs, 1 KB of prompt) and drop prompts from settled runs.  Run the retention pass in the flush, not in `save()`.  (Effort: M)

### CPU-7 [P1 per the prior audit; code-verified only] [STILL-OPEN DR3] ACP and Codex spawn a fresh child per turn
- Evidence: `acp/core.ts:804` calls `spawnCli`.  The session is established at `:1544` (`session/load`) and `:1557` (`session/new`).  Codex does the same at `codex.ts:234`.  Only `claude.ts:965-998` keeps a warm session.
- Impact: every turn pays init plus a full history replay.  I did not measure it.  Whether each CLI supports a kept-alive stdio session still needs per-CLI verification.
- Recommendation: as in DR3, start with the engine you use most.  (Effort: L)

### CPU-8 [P2] [NEW] The VPS credential sync retries a deterministic failure every minute
- Evidence: failure backoff is a flat 60 s (`vps-computer.ts:176`, `:202`).  It retries on every turn once the 60 s has passed.
- The live log shows 15 failures between 14:01 and 15:23 UTC today.  Each is `[vps] automatic CLI credentials sync failed: … tar: … Cannot mkdir: Permission denied`, one failure about every 5 minutes.
- Each attempt builds the tar fully in memory (`vm-cli-credentials.ts:496-501`, `Buffer.concat`) and uploads it over ssh.  `~/.config/gcloud` is 93 MB on disk.  I did not confirm the archive size.
- Recommendation: use exponential backoff, a cap, and a latched "needs a human" state.  Dedupe the log line.  Stream the tar instead of buffering.  (Effort: S)

### CPU-9 [P2] [NEW] The usage-quota poller does fsynced writes, fetches and 1 MiB allocations every 30 s
- Evidence: `usage-quota.ts:87` and `:229-233` poll every 30 s.  Each poll allocates a zero-filled 1 MiB buffer (`local-usage-monitor.ts:192`).  It also does a remote `fetch` (`:360-375`) even though the data comes from a 4-hour collector (comment near `:260`).
- Each capped window calls `recordInstanceCap` (`:273`, `:315`), which unconditionally runs `persist()` (`model-fallback.ts:883`, `:790-801`).  That is a synchronous `writeFileAtomic` with fsync.
- I could not observe this live: `quota-cooldowns.json` is 28 bytes now, because no cap is active.  This is inferred from code.
- Recommendation: persist only on change.  Poll the local file by mtime.  Poll remote at 5 minutes or more with backoff on 4xx.  (Effort: S)

### CPU-10 [P2] [NEW] `server/index.ts` is a 15,955-line, 800,763-byte single module
- It grew from 11,634 lines on Sep 24 (`beb2e689`) to 15,955 now, which is +37% in 13 days.  166 of the 552 commits since Sep 7 touch it.  Every commit shows one git user, so authorship says nothing about seats.
- One `handleRequest` closure spans `index.ts:9826-15692`, which is 5,867 lines (37% of the file) and 182 `method ===` route branches.  Only `routes/linq-webhook.ts` exists as a route module.
- A real incident shows the module-init-order cost: the comment at `:672-684` records BOTFLEET-2M and Sentry 7768010831, where a timer walked an uninitialised binding.
- tsc time was not measured.
- Section map (line ranges):

| Lines | Content |
|---|---|
| 1-485 | 177 imports and constants |
| 486-600 | ports, early-listen boot gate, interrupted-turn record |
| 601-852 | SSE and replay, screen pollers, update control, transcript sweeps, cfg, Infisical preload, registry load, bus |
| 853-1313 | peer-comms tokens, doomed-dispatch breaker, dispatch holds, spend gates |
| 1314-1875 | computer control, model lineage, local-VM and auto-consent helpers |
| 1876-2290 | background jobs, retention sweeps (`:2078-2128`), `wireTask`/`wireBot`/`publicBot`, group operations, snooze sweep |
| 2292-2767 | message pages, wire redaction, event folding, approvals, interrupts |
| 2768-3418 | stall watchdog, permission review, unattended marks, local-VM leases |
| 3419-4435 | `launchFallbackTurn` (about 1,017 lines) |
| 4436-4710 | fallback chain, delegation watch, steer-queue drain |
| 4711-5810 | `startTurn` (1,095 lines) |
| 5812-6402 | routines wiring, webhooks, ingress, resource triggers |
| 6404-7146 | group turn engine, agent-tool executors, boot-recovery coordinator |
| 7147-8290 | `runGroupMemberTurn` (to 7883), connector and secret resumes |
| 8293-9192 | CLI test, config status, provider-reload machinery |
| 9193-9825 | HTTP plumbing, readiness, quiesce, voice summaries |
| 9826-15692 | the route table |
| 15694-15955 | scheduler start, `booting=false` (`:15802`), signal handlers |

- Route sub-blocks are on one line each: peer comms (`:9872`), routines and webhooks (`:10292`), events (`:10448`), bots (`:10525`), channels and teams (`:10765`), bot CRUD (`:11611`), skills, memory and checkpoints (`:12118`), tasks (`:12801`), computer and VPS (`:13012`), update and health (`:13283`), quotas (`:13424`), instances and config (`:13690-14275`), apply-defaults (`:14276-15248`), voice and connectors (`:15249-15495`), Box (`:15496`).
- Recommendation: split into `server/routes/*.ts` (about 20 files, each `(ctx) => handler`), `server/turn/{dispatch,fallback,group}.ts` and `server/boot/*.ts`.  Move the route table first, since it is stateless and the cheapest.  (Effort: L)

### CPU-11 [P3] [STILL-OPEN HS24, low confidence] Checkpoint snapshot is awaited before every dispatch, and the shadow repos never gc
- Evidence: `index.ts:5363-5366` awaits `checkpoints.snapshot` before the engine runs.  `checkpoints.ts:131-133` sets `gc.auto = 0`, and nothing prunes.
- There is no `~/.botfleet/checkpoints` directory on this Mac, so this path is unexercised here.
- Recommendation: run a periodic `git gc --prune` on idle shadow repos and cap the checkpoint count.  (Effort: S)

### CPU-12 [P3] [NEW] Resource triggers: 3 sync spawns per tick, and no back-off on a permanent condition
- Evidence: `ResourceTriggerManager.tick` calls `sampleFn()` before the trigger loop (`resource-triggers.ts:532`).  That runs `vm_stat`, `df` and `sysctl` with `execFileSync` (`:197`, `:289`, `:318`), 3 + 5 + 3 s worst-case timeouts.
- That is 8,640 sync spawns per day.  I timed them at about 10 ms in total.  All 3 triggers are enabled here, so the sampling is needed.
- The triggers re-fire at the fixed 240-minute cooldown while the condition holds (`resource-triggers.json`, no content read): `load_1m>65` fireCount 129, disk 52, swap 32, so 213 Housekeeper turns.  The live load is 102.
- Recommendation: use async `execFile` and share one sampler with `jobs/admission.ts`.  Add an escalating cooldown while a condition persists across fires.  (Effort: S)

### CPU-13 [P3] [NEW] About 146 idle wakeups per minute, 82% from one timer
- The 500 ms jobs log timer is always armed (`jobs/registry.ts:1091-1093`).  It allocates `[...records.values()]` each tick even with no jobs running.  That is 120 of the 146 per minute.
- Recommendation: arm it on the first running job and disarm on the last.  (Effort: S)

### CPU-14 [P3] [NEW] Boot: listen to ready takes 8.5 to 18 s, and some one-shots block the loop
- Evidence: in the live log, lines 2 to 6 show listen at 17:36:52.077 and ready at 17:37:10.089 (18.0 s).  Lines 9 to 13 show 18:23:34.909 to 18:23:43.429 (8.5 s).  `/api/*` returns 503 meanwhile.  Health answers `booting:true` (HS19 is fixed).
- A stale comment at `index.ts:703-707` says the transcript sweep runs "long before `server.listen`".  Listen is at `:554` and the sweep at `:720`.  Sync work from `:554` to the first await at `:751` still blocks accept.  That includes `sweepTranscriptRetention`, `new ItemIoStore` and `loadConfig`.
- Boot-plus-60 s one-shots are synchronous.  `sweepOrphanedWorkspaces` does a recursive `statSync` walk only to report bytes and a recursive `rmSync` (`workspace.ts:198-218`, `:256-265`).  `pruneDeadThreads` can `VACUUM` the 360 MB file on the main thread (`message-db.ts:354-362`).  Currently `freelist_count` is 0 and 9 of 21 workspaces are orphans under the 14-day bar, so neither fires today.
- Recommendation: do the retention one-shots asynchronously or in a worker.  Fix the comment.  (Effort: S)

### CPU-15 [P3] [NEW] Small O(n) work on per-event and per-turn paths
- `routines.handleRuntimeEvent` does `this.runs.find(...)` with an array literal per element, for every runtime event on any thread (`routines.ts:1517`).  I measured 44 µs per call over 2,001 runs.  That is 0.9% CPU at 200 events/s.  Index runs by `threadId`.
- `currentRuntimeReadiness` calls `routines.listRuns()` (filter, sort, clone) just to count active runs (`index.ts:9434-9470`).  That is 1.2 ms per call.
- `patchBot(…inflightThreadId…)` does a synchronous fsync write of the 168 KB `bots.json`, twice per turn (`store.ts:1962-1968`).  It is deliberate for crash safety.
- Recommendation: index runs by thread and by status.  (Effort: S)

### CPU-16 [P3, inferred] [NEW] No global cap on concurrent turns or warm Claude sessions
- Evidence: `claude.ts:965-971` keeps a `Map` of sessions with a 10-minute idle close and no size cap.  `knob-map.ts` has 13 knobs (jobs, Sentry, spend, Infisical) and none for concurrency.
- The live harness has 1 child right now, so this is a risk only.
- Recommendation: add a cap with LRU close, and a knob.  (Effort: S)

## Timer Inventory (server/, excluding tests and fakes)

| Timer | Period | Idle work | Source |
|---|---|---|---|
| Jobs tick | 5 s | counters, prune each minute | `jobs/registry.ts:1088` |
| Jobs log check | 500 ms | array copy, no I/O (CPU-13) | `:1091` |
| Jobs sweep | 5 min | sweep | `:1095` |
| Routines tick | 10 s | `reconcileOrphanedRuns` over 2,001 runs, queue scan | `routines.ts:1107` |
| Resource triggers | 30 s | 3 sync spawns (CPU-12) | `resource-triggers.ts:517` |
| Usage-quota poll | 30 s | file read, HTTPS fetch (CPU-9) | `usage-quota.ts:229` |
| Antigravity quota | 60 s | armed, CLI spawn gated by config | `antigravity-quota.ts:413` |
| Turn watchdog | 60 s | map sweep | `index.ts:2864` |
| Snooze sweep | 60 s | scans bots and tasks | `index.ts:2284` |
| Doomed-skip drain | 60 s | Sentry count if active | `index.ts:948` |
| SSE keepalive | 25 s per client | one write | `index.ts:10512` |
| Infisical refresh | 5 to 15 min | HTTPS if configured | `infisical.ts:338` |
| Transcript and orphan sweeps | daily plus boot-plus-60 s | stat walk | `transcript-retention.ts:492`, `:668` |

Event-driven or armed only on demand: update status timer (2 s, only during an update, `update-control.ts:1205`), engine recheck (20 s doubling to 5 min, `harness/registry.ts:801`), telemetry outbox (`telemetry-outbox.ts:570`), screen pollers (viewer-gated, `screen-poller.ts:81`), CLI group watch (`procs.ts:493`).  The Grok quota poller has no timer.

## Course Corrections

1. Stop treating thread count as the memory bound.  Bound by bytes, never full-load a thread to answer a one-row question, and give every thread a size ceiling that rollover, archive or trim enforces for live and legacy threads alike (CPU-2, CPU-3).
2. Stop persisting and broadcasting every token.  Settled items are the record and deltas are ephemeral (CPU-4, CPU-5).  This cuts disk, SSE and the log-history problem together.
3. Move heavy synchronous sqlite and JSON work off the event loop: search, VACUUM, orphan deletion, `routines.json` serialisation.  An always-on harness whose health probe can be frozen by a keystroke is the wrong shape (CPU-1, CPU-6, CPU-14).
4. Make every recurring operation back off or be event-driven by default: VPS sync, quota polls, resource-trigger re-fires, the 500 ms jobs timer (CPU-8, CPU-9, CPU-12, CPU-13).
5. Split `server/index.ts` starting with the 5,867-line route table.  The cost is concrete: 166 commits since Sep 7, a documented init-order incident, and no per-route test isolation (CPU-10).

## Fixed Since Prior Audits

| Id | Evidence |
|---|---|
| HS4 (mechanism) | `routines.ts:1860-1906` debounce plus `writeFileAtomic`, no indent.  Residual is CPU-6 |
| HS5 | `webhooks.ts:1395` debounce.  `webhooks.json` is 857 KB, stringify 4 to 7 ms |
| HS6 | `store.ts:1129-1166`, 250 ms debounce |
| HS7 | `index.ts:3955` `appendBounded`, 4 MB cap |
| HS8 | `telemetry-outbox.ts` single `persistPass` per flush |
| HS10 | `bus.ts:228` async bounded queue.  `redactSecretsForLog` on a 5 MB result measured 7.2 ms |
| HS11 | `rolling-spend.ts` incremental scan with persisted cursor |
| HS13 | `index.ts:15700-15710` gated on a configured Antigravity instance |
| HS14 | Grok quota poller has no timer |
| HS15 | `screen-poller.ts:76-86` viewer-gated |
| HS16, HS17 | `sse-broadcast.ts` backpressure and byte-capped replay |
| HS18 | `index.ts:15855-15885` records interrupted turns on SIGTERM |
| HS19 | `index.ts:505-577` early listen |
| HS22 | `sweepThreadToolState` (`index.ts:2465`, called at `:3994`) |
| HS26 | `harness/registry.ts:613` atomic write |
| DR1 | `chief-of-staff.ts:34` busy state excluded |
| DR2 | `acp/core.ts:36`, `:632-706` retry |
| DR4 | `antigravity.ts:222-265` reader/writer lease |
| DR5 | `tools/computer.ts:34-39`, `:220-235` default limit |

Not re-verified: HS9, HS20, HS23, HS25, DR6 to DR11.  HS12 and HS21 are intentionally not in this table (CPU-2).

---

Summary: report file not written (no Write tool); full report above.
- Top 3: CPU-1 `/api/search` blocks the loop for 1.8 to 7.2 s per query; CPU-2 full-thread hydrates still happen (3.2 s per giant thread, about 7 to 11 s extrapolated per hydrate); CPU-3 live data growth is unbounded (3.5 GB to 5.2 GB in 13 days).
- Count by severity: 2 P1, 8 P2, 6 P3 (CPU-7 is P1 per the prior audit but P2 by my own verification).
