# R2 — Runtime Evidence: How BotFleet Is Actually Operating (Oct 7, 2026, 10:24am to 10:50am)

Observer only: no writes, restarts, or mutating calls.  All numbers below were measured on this Mac during this review.  Method notes: `ps` is blocked by the secret-safety hook, so process data came from `top`, `lsof` (cwd and fd only), and `pgrep` PIDs; process ages are inferred from boot logs.  Orphan check: orphans reparent to launchd, so I looked for any process whose cwd is under `~/.botfleet/workspaces` and found only the one live engine child.  Log timestamps are UTC (`Z`) unless stated.

## Operating Snapshot

| Area | Measured |
|---|---|
| Host | up 3d 8h, 10 cores, 16 GB RAM, swap 32,208 of 32,768 MB (98.3%), compressor 5–6 GB, disk 92% used (31 GB free).  Resource watch, 280 samples: swap p50 96.7%, min 93.6%, max 99.2%.  Load1 above 20 in 43% (Oct 6) and 63% (Oct 7) of samples, max 663 |
| Harness | launchd `app.botfleet.server` PID 24774, one process, 538–818 MB, 0.1% CPU, 130 fds, 13 threads, up about 21h (boot 1:23pm Oct 6).  Runs `server/index.ts` from `~/apps/botfleet-server` via `node --experimental-strip-types` (`/Users/jay/apps/botfleet-server-start.sh:266`), detached HEAD `db2599b89` |
| Children | harness has exactly one child (grok CLI, PID 32846, 27 MB, 0.4 s CPU, cwd in a bot workspace).  No orphan or duplicate engine CLIs |
| Electron app | `/Applications/BotFleet.app` v1.0.31, bundle `app.botfleet.macos`: main 78 MB, renderer 600 MB, GPU/helper 264–315 MB, helper 11 MB, cua-driver 62 MB.  BotFleet total about 1.7 GB of 15 GB used |
| `/health` | `{"app","pid","static","ready","booting"}` only.  n=20: p50 42 ms, p95 1,158 ms, max 3,512 ms (host load 18–53) |
| Data dir | `~/.botfleet` 5.2 GB (was 3.5 GB on Sep 24, +49% in 13 days) |
| CI on main | 100 runs in 5 days: 75 success, 22 cancelled, 3 failure |

## Findings

### RUN-1 [P1] [STILL-OPEN] The host runs saturated and the admission gates sit above its normal operating point
- Evidence: swap p50 96.7% (`~/Library/Logs/mac-resource-watch.log`, 280 samples).  Job and webhook admission refuse at `maxSwapPercent: 98` (`server/jobs/admission.ts:27`; `server/resource-triggers.ts:229`), so they trip only on the last 1–2 points.  `errors.log` holds 101 ACP `initialize timed out ... (host load N per core)` entries, mean 44.7 load per core (max 102.4) against 180 s and 300 s deadlines.  In the last 7 days `session/prompt timed out` is the top error (96), then init timeouts (56), then no-output stalls (35).  Sentry's top unresolved issues are the same class: BOTFLEET-2F (24 events), -1P (22), -2G (21), -1D (16).
- Impact: the dominant failure mode is waiting on a thrashing host, not bot logic.  BotFleet itself is about 1.7 GB; the heaviest consumer is an unrelated Grok TUI (PID 530, 7.4 GB, 132 Python children), which is host context rather than a BotFleet defect.  Prior audit "Live Host State" (Sep 24) measured 95.8% swap; it has not improved.
- Recommendation: calibrate admission to the measured distribution (for example refuse webhook wakes above p50 plus a margin, or on compressor share), add a concurrent-engine-start cap, and report host pressure in `/health`.  (Effort: M)

### RUN-2 [P1] [STILL-OPEN HS4] Webhook routines churn the run history and run unattended turns around the clock
- Evidence: `routines.json` is 6.2 MB with 21 routines and 2,001 runs covering only 62.7 hours, because retention is by count (`server/routines.ts:355`, `:1855`).  Status mix: 803 completed, 651 cancelled, 544 failed (60% not completed).  1,931 of 2,001 runs are webhook-triggered; 650 were cancelled with p50 0 s (coalesced instantly) yet each still stores a row.  `prompt` is copied into every run: 4.1 MB of 6.2 MB (66%).  Per routine: GitHub UI Pass 687 runs, Compile gates GitHub 680 (354 cancelled), GitHub Merge Conflicts and Issues 473 (278 cancelled).  Only 52 scheduled runs survive in the window.  About 284 webhook runs complete per day.
- Impact: roughly 280 unattended completed turns per day is a standing cost exposure (spend not aggregated here).  Run history lasts 2.6 days, so scheduled-run failures (Sentry cron issues BOTFLEET-1B, -24, -1K, -1Z, -16) fall out of local history almost immediately.  The file is whole-rewritten at 6.2 MB per coalesced save; the Sep 12 wedge was 35.7 MB, so the headroom is still thin.
- Recommendation: do not persist a run row for a webhook delivery coalesced at creation; store the prompt once per routine and reference it; retain by age (14 days) and per-routine count instead of one global 2,000.  Move runs to sqlite.  (Effort: M)

### RUN-3 [P2] [NEW] Local VM or Docker setup failures never open the doomed-dispatch breaker
- Evidence: routine "GitHub UI Pass → Designer" produced 490 `dispatch_failed` runs between Oct 4 7:34pm and Oct 5 3:43am (text "Start docker first (App Settings → Local VM)" 343, "Create the Local VM" 147); none since (3 runs in the last 24 h, all completed).  `~/.botfleet/doomed-dispatches.json` is `{"doomed": []}`.  The breaker is fed only by `runtime.error` events with `setup: true` (`server/index.ts:860-877`), emitted for missing CLIs (`server/procs.ts:392-394`) but not for `statusProblem` (`server/container-computer.ts:629-636`).  Four Coolify "host usage eyes" runs failed the same way on a VPS ("Prepare the pinned BotFleet CUA image on the VPS").
- Impact: 490 failed unattended dispatches in 8 hours (about 60 per hour), each a webhook-triggered row plus a retry slot, until a human fixed the environment.
- Recommendation: treat any `dispatch_failed` with the same message from the same routine three times in a row as doomed and hold the routine with a visible reason.  (Effort: S)

### RUN-4 [P2] [STILL-OPEN HS2] `messages.db` grows without bound for live threads
- Evidence: 360 MB, 118,881 rows, 116 threads (Sep 24: 251 MB, 58,532 rows, 76 threads: rows +103% and bytes +43% in 13 days).  `freelist_count` is 0, so every byte is live data.  About 5,000 rows per day (range 1,836–10,113 over the last 7 days).  Largest thread: 32,799 rows and 90 MB.  `text/system` rows: 16,320 at 96 MB (avg 6.2 KB, max 130 KB); 13,526 of them are older than 7 days (87 MB).  Pruning covers only dead threads, once, 60 s after boot (`server/message-db.ts:282`; `server/index.ts:2093-2127`).
- Impact: cold-start `readThread` and search costs scale with the whole file; 87 MB of week-old system rows is never read again in practice.
- Recommendation: add a rolling per-thread window for system and activity kinds (for example 14 days or 2,000 rows) and a recurring, not boot-only, sweep.  (Effort: M)

### RUN-5 [P2] [NEW] Message text is stored twice and searched by full scan
- Evidence: `insertMessage` writes `message.text` into the `text` column and the whole message, text included, into `json` (`server/message-db.ts:186-190`).  47,752 rows carry both: `text` totals 124 MB of the 343 MB of row data (about 36%).  `searchMessages` runs `lower(text) LIKE '%q%'` with no full-text index (`server/message-db.ts:385-400`).
- Impact: a third of the file is redundant, and every search reads the whole table on a box with 98% swap.
- Recommendation: drop `text` from `json` or derive search from an FTS5 table.  (Effort: M)

### RUN-6 [P2] [STILL-OPEN HS1, HS3] Live-thread logs and live workspaces have no global bound
- Evidence: `native/` 1.9 GB (was 1.2 GB), 94 files, 13 rotated files pinned at the 64 MB cap, live files up to 60 MB; per-thread ceiling is 128 MB (`server/transcript-retention.ts:48`) with 81 live threads, so the theoretical ceiling is about 10 GB.  `events/` 307 MB (was 143 MB).  `workspaces/` 2.4 GB in 21 dirs; one workspace is 2.04 GB (85%): a Socratic.Trade clone of 1.1 GB with 975 MB `node_modules`, plus 347 MB `tmp734` and a 293 MB litestream copy.  The workspace sweep removes only workspaces of deleted bots (`server/index.ts:2094`).
- Impact: the 13-day growth (+1.7 GB) came almost entirely from these three; at the current slope the data dir adds 3–4 GB per month on a disk with 31 GB free.
- Recommendation: a global byte budget for `native/`, `events/`, `workspaces/` with oldest-idle-first reclaim, plus a per-workspace size warning in Settings.  (Effort: M)

### RUN-7 [P2] [NEW] Text-to-speech clips are saved as attachments forever
- Evidence: `attachments/` is 2,258 files and 213 MB (Sep 24: 47 files, 26 MB).  2,188 are `.mp3` (avg about 87 KB); 2,141 files of all types were created Oct 2–5 (167, 913, and 1,061 per day on Oct 2, 3, and 5).  Clips are written by `saveAttachment` (`server/index.ts:15232-15233`); `server/attachments.ts` has no delete path.  `tts-usage.jsonl` logs 2,218 MiniMax syntheses and 162,332 characters in the same days.  All 2,188 md5 hashes are distinct, so this is not duplicate synthesis.
- Impact: roughly 190 MB in four days of voice use, unbounded, plus per-character provider spend with no cap visible in the UI.
- Recommendation: TTL (7 days) and a byte cap for audio attachments; reference clips by message so the sweep can skip live ones.  (Effort: S)

### RUN-8 [P2] [NEW] The installed app, the harness, and `main` are three different builds, and nothing at runtime says which
- Evidence: `/Applications/BotFleet.app/Contents/Resources/server/build-identity.json` reports `sourceCommit d9e646ff` (Oct 3, 8:54pm UTC), 89 commits behind `origin/main`; the harness HEAD `db2599b89` differs from that commit by 127 `server/` files and 11,444 added lines.  `/health` returns no commit, boot time, or version (`server/index.ts:541-549`), and `package.json` has read 1.0.31 across all of those commits.
- Impact: the "ubf silently no-oped" class of failure is undetectable from the outside; the packaged renderer talks to a harness 85+ commits newer.
- Recommendation: put `sourceCommit`, `bootedAt`, and `behindMain` in `/health`, and warn in the UI when the app and harness commits differ.  (Effort: S)

### RUN-9 [P2] [STILL-OPEN, R8 / issue #285] The updater feed can never deliver an update
- Evidence: `~/Library/Logs/botfleet/updater.log`: "Update for version 1.0.31 is not available (latest version: 0.1.38, downgrade is disallowed)", every 7 hours.  `gh release list` shows `v0.1.38` (Aug 31) as the only and latest release; `electron-builder.yml:19-22` publishes to that repo.
- Impact: every packaged install, including any non-owner install, is stranded; owner Macs depend entirely on the manual `ubf` path.
- Recommendation: cut a transition release as the AGENTS.md rollout doc describes (owner approval required for public releases), or remove the auto-check until one exists.  (Effort: S)

### RUN-10 [P2] [STILL-OPEN HS9] Backups in the live data dir still pile up and include credential material
- Evidence: 45 `.bak*`, `bak-*`, `backups-*` entries, 93.8 MB (Sep 24: 36 files, 90 MB), mtimes Aug 30 to Oct 1.  Largest: `routines.json.bak-prompt-bloat-20260912-203847` 34.1 MB.  A pre-rotation config backup and two one-time secret handoff files (all mode 0600, 28 days or older) remain.  Two zero-byte stray DBs: `botfleet.db` (Sep 24) and `db.sqlite` (Sep 2).
- Impact: stale credentials sit on disk after rotation; the one-time files were meant to be read once.
- Recommendation: move agent-made backups to a dated directory outside the data dir with a 14-day sweep, delete the one-time secret files and the pre-rotation config backup, and remove the empty DBs.  (Effort: S)

### RUN-11 [P2] [NEW] Data-dir permissions are inconsistent
- Evidence: `~/.botfleet` is `drwxr-xr-x`; `bots.json`, `groups.json`, `routines.json` are `-rw-r--r--` (49 top-level files group- or world-readable); `messages.db`, `config.json`, `webhooks.json`, `native/*` (79 files) and `events/*` (84 files) are 0600.  `mkdirSync(DATA_DIR)` runs without a mode in `server/config.ts:1392` and `server/store.ts:918`; only `server/section-context.ts:84` passes `0o700`.  File contents were not inspected.
- Impact: bot prompts and routine text are readable by other local accounts; whichever `mkdirSync` runs first decides.
- Recommendation: create the dir with `0o700` everywhere and write JSON stores with `mode: 0o600` through `writeFileAtomic`.  (Effort: S)

### RUN-12 [P2] [NEW] The VPS credential sync fails every attempt and floods the server log
- Evidence: 15 failures in 82 minutes (9:01am to 10:23am), each `[vps] automatic CLI credentials sync failed ... Permission denied` with tar stderr naming `.config/gcloud/logs/...` ("Cannot mkdir", "Cannot open").  In `server.log` 284 lines, 90 are `tar:` lines and 15 are the summary.  Backoff after failure is 60 s, success TTL 10 minutes (`server/vps-computer.ts:172-203`).
- Impact: bots using the shared VPS never get CLI credentials, and every turn on that path pays an ssh round trip; the log that has no size bound beyond 20 MB (`botfleet-server-start.sh:25`) fills with noise.
- Recommendation: exclude `logs/` (and other volatile dirs) from the sync plan, back off exponentially on repeated failure, and log one line.  (Effort: S)

### RUN-13 [P2] [STILL-OPEN UI1] The Electron renderer burns CPU while no bot is working
- Evidence: three samples 5 s apart: renderer PID 15984 at 42%, 47%, 61% CPU and GPU/helper PID 15153 at 12–16%, while the only engine child sits at 0%.  Cumulative: 76 CPU-minutes and 28 CPU-minutes.  The Sep 24 audit measured 62% cumulative and 16% instant.  `requestAnimationFrame` loops remain in `src/components/CursorAvatar.tsx:1584-1611`; I did not isolate which component is responsible.
- Impact: about 0.6–0.75 of a core continuously on a host already at load 18–53.
- Recommendation: profile the idle renderer in a Playwright run and cap or pause every avatar and infinite CSS animation when the window is hidden or no bot is busy.  (Effort: M)

### RUN-14 [P2] [NEW] Engine launch failures are mislabeled or repeated
- Evidence: `errors.log`, Oct 1–7: "`/Users/jay/apps/dsh-runtime/dsh.sh` isn't installed, or isn't on this app's PATH" 26 times (186 overall), but `ls -la` shows the file present and executable (834 bytes, Sep 17); the message comes from `server/procs.ts:392`.  `mcodeAgent exited 1` 18 times, e.g. `/Users/jay/.local/bin/mcode: line 4: /Users/jay/.local/current: No such file or directory`.  Sentry BOTFLEET-2J and -2N record the same.
- Impact: operators are told to install something that is installed; the real cause (a missing inner target or an ENOENT from the wrapper) is hidden, so the same bots fail repeatedly.
- Recommendation: distinguish "script not found" from "script ran and exited ENOENT" and surface the wrapper's stderr tail; feed both into the doomed breaker.  (Effort: S)

### RUN-15 [P2] [NEW] Observability is inconsistent: boot lines say Sentry and Infisical are off, yet events flow, without a release
- Evidence: both boots (Oct 6, 12:36pm and 1:23pm) print `[sentry] disabled: no DSN configured` (`server/observability.ts:226-229`) and `[infisical] disabled: not configured` (`server/infisical.ts:507`; AGENTS.md says Infisical is the sole source of truth).  Yet Sentry holds events from `server_name the owner Mac` at 13:35:39Z, 15:03:48Z, 15:23:23Z, matching `errors.log` entries to the second, all with `release: null`.  24-hour Sentry volume: 150 events from `the fleet VPS` (releases are commit SHAs), 12 from `fleet-ci`, 7 from the Mac.  Seven-day: 334 events in environment `fleet-ci`, 146 production events with no release.
- Impact: the boot line cannot be trusted; Mac events cannot be tied to a commit, which compounds RUN-8; CI and Hetzner events share the production project, so issue counts overstate Mac failures.
- Recommendation: stamp `release` from `build-identity`, print the boot line after the DSN is actually applied, and route CI to its own environment filter.  (Effort: S)

### RUN-16 [P3] [STILL-OPEN RH7] The always-on checkout is 4 commits behind `origin/main`
- Evidence: harness `db2599b89` versus `d2bc60257` (confirmed with `git ls-remote`); the 4 commits touch 13 files across `server/`, `src/`, `electron/` (959 insertions), including #883 (ACP prompt byte budget).  `ubf` (`/Users/jay/apps/update-botfleet.sh`) is on demand and nothing schedules it.
- Impact: expected between runs, but fixes sit unapplied for hours to days.
- Recommendation: an idle-gated nightly `ubf` or a "behind main" notice (see RUN-8).  (Effort: S)

### RUN-17 [P3] [NEW] `/health` is slow under load and a 2-second health check can misread it
- Evidence: p95 1,158 ms and max 3,512 ms over 20 samples; the start script treats anything over `curl -m 2` as unhealthy (`/Users/jay/apps/botfleet-server-start.sh:47`), and `mac-process-watch` polls the same endpoint.
- Impact: a healthy-but-slow harness can look down and be kickstarted, which re-dispatches in-flight turns.
- Recommendation: answer `/health` from a dedicated lightweight listener or raise the probe timeout to 10 s.  (Effort: S)

### RUN-18 [P3] [NEW] CI on main: 22% of runs cancelled, all 3 failures on Windows
- Evidence: 100 runs, Oct 2–7: 75 success, 22 cancelled, 3 failure (all `typecheck + test (windows-latest)`, step "Complete application test chain", for example run 37436005395).  Success wall time p50 18.6 min, p90 51.8 min, max 108 min, 1,897 wall-minutes in 5 days.  `startedAt` equals `createdAt`, so queueing cannot be separated from execution.
- Impact: cancelled pushes never receive their own verdict; the p90 means a typical merge waits most of an hour.
- Recommendation: report job-level queue time and re-run the Windows leg before declaring it flaky.  (Effort: S)

### RUN-19 [P3] [NEW] Docs drift: the iMessage relay is documented as always-on but is disabled
- Evidence: `~/Library/LaunchAgents/com.jay.botfleet-imessage-relay.plist.disabled` (Sep 1); `launchctl list` shows only `app.botfleet.server`, the app, and the `mac-resource-watch` interval job.  AGENTS.md "Mac Local Processes" lists the relay.  Also stale: `com.jay.botfleet-server.plist.disabled` and `.bak-20260902`.
- Impact: the process inventory and `MAC-LOCAL-PROCESSES.md` mislead the next agent.
- Recommendation: update both lists or re-enable the job.  (Effort: S)

## Fixed Since Prior Audits

| Prior id | Evidence it is fixed |
|---|---|
| HS1 / HS3 orphan reclaim (partial) | `native/` files 209 to 94, `events/` 202 to 84, `workspaces/` 103 dirs to 21; sweeps at `server/index.ts:2093-2127` and `server/transcript-retention.ts:534`.  Live-thread growth remains (RUN-6) |
| HS2 dead-thread prune and vacuum | `freelist_count` 0; `pruneDeadThreads` at `server/message-db.ts:282`.  Live-thread growth remains (RUN-4) |
| HS5 `webhooks.json` size | 3.0 MB to 0.75 MB; 2,000 deliveries now 278 KB, attempts capped at 500 |
| HS7 `errors.log` cap | 447 KB against a 4 MB cap (`server/index.ts:719`, `:3955`) |
| `routines.json` wedge | 35.7 MB (Sep 12) to 6.2 MB; saves coalesced into one atomic write (`server/routines.ts:366`) |
| UI4 hourly updater 404 loop | `updater.log` now logs one info line about every 7 hours.  Feed itself remains broken (RUN-9) |
| Engine process leak | one engine child under the harness; no process with a workspace cwd other than that child |

## Course Corrections

1. **Treat host pressure as the normal operating condition, not an alert.**  At 97% median swap, 98% admission gates and fixed 180–300 s ACP deadlines mean the top error class is "waited on a thrashing machine".  Budget BotFleet to its own envelope (concurrent engine starts, webhook wakes per hour, renderer idle CPU) instead of hoping the host recovers.
2. **Stop using whole-file JSON and unbounded folders for event-like data.**  Runs, deliveries, attempts, messages, TTS clips, and transcripts all grow by append.  Move them to one sqlite store with age and byte retention, store prompts by reference, and keep JSON only for small config.  Every prior and current data-growth finding is this one design choice.
3. **Make "what is running" observable before adding more updaters.**  `/health` should carry commit, boot time, and distance from `main`; the app bundle, harness checkout, and `main` currently disagree by 85+ commits with no signal.  Schedule an idle-gated update, or retire the pretense that the electron-updater feed works (RUN-9).
4. **Generalize the doomed-dispatch breaker to every repeated dispatch failure, and to webhook floods.**  490 identical failures in 8 hours and 650 instantly cancelled runs show the breaker covers only missing CLIs.  Dedupe webhook deliveries before a run row exists, and pause a routine on three same-reason failures.
5. **Give the observability stack one truth.**  Boot lines, Sentry events, and Infisical state disagree; CI and Hetzner share the Mac's production project; Mac events lack a release.  Pick one source for the DSN, tag releases from `build-identity.json`, and print status after configuration is applied, so an operator can trust what the log says.
