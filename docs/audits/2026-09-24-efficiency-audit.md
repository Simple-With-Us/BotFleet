# BotFleet Efficiency And Performance Audit

Date: Thu, Sep 24, 2026 (Central Time).  Seat: Claude.  Board row `107f9043` (P2, agent-report).  Source: `origin/main` at `beb2e689` (PR #541), read from `~/apps/botfleet-claude-audit`.  Read-only; nothing was changed on the host or in any lane.

## Scope And Method

The owner asked for every way BotFleet is not performing efficiently or as intended, across the desktop app, the harness server, the iOS companion, and the tools it integrates with.  This report combines three kinds of evidence:

1. **Live host state** on the owner's Mac (process table, ports, swap, data directory, harness log), captured between 1:30 pm and 2:10 pm CT.
2. **Code reading** of `origin/main` by six read-only workers, one per area: harness core, engine drivers and tools, web renderer and Electron shell, iOS app and companion sidecar, operations and integrations, and prior-audit reconciliation plus repository hygiene.
3. **Fleet memory**: THE BOARD, the effort log, fleet recall, and the audits already in `docs/audits/`.

Findings are graded P0 (outage, data loss, runaway cost), P1 (serious performance or reliability defect), P2 (clear inefficiency), P3 (minor).  Each finding names the evidence and, where one is known, a fix.  Problems with no identified fix are still listed.  Items already tracked on THE BOARD or in an issue or PR are marked so nobody re-files them.

## Executive Summary

BotFleet works end to end, but it is paying for its own growth in four ways, and the bill is visible on the owner's Mac today.  This report lists 97 verified findings (7 P0, 36 P1, 33 P2, 21 P3) across the harness (26), engine drivers and tools (11), the iOS companion and its sidecar (31), the web renderer and Electron shell (9), operations and integrations (13), and repository hygiene (7).  Four of the token-waste items landed as fixes on Sep 24 while the audit ran and are marked as such.

1. **The harness does too much synchronous work on its hot path.**  Every runtime event is deep-cloned, run through seven secret-redaction regexes with no size cap, and appended to disk on the main thread (HS10).  `bots.json` is rewritten with `fsync` on every activity blink (HS6), `routines.json` costs about 45 ms of blocked loop per save with no `fsync` and a shared temp path (HS4), `webhooks.json` rewrites 3 MB per webhook (HS5), and boot reads 16 MB event files whole (HS11).  `GET /api/bots` loads every thread into an unbounded cache, the likely source of the 486 MB harness footprint (HS12).  The port does not open until Infisical, recovery, and provider rebuild finish, so health connection-resets during every boot by design (HS19).
2. **Restarts multiply cost.**  The harness booted or was attached 29 times in two days.  A graceful stop looks like a crash, so every restart re-dispatches in-flight turns and re-spends tokens (HS18), the desktop updater has retried a 404 release every hour for 67 hours (UI4), and the launchd wrapper retries every 5 s forever if a janitor removes `node_modules` (OP10).  Nothing reclaims disk: per-thread transcript caps hold but dead threads keep 160 MB each (HS1), 85 of 103 workspaces are stale (HS3), `messages.db` never shrinks (HS2), and 24 worktrees hold about 24 GB of `node_modules` (RH1).
3. **The phone path is loud, blind, and currently broken.**  The APNs breaker cannot trip because one shared counter resets on any other device's rejection (IO1b), so transport failures logged one error line every 40 s for two days (IO1); pushes are now latched off because Apple refuses the signing key, the latch dies on every relaunch, and the phone still says notifications are on (IO2).  An open circuit silently destroys queued approvals (IO3).  The sidecar lives and dies with the Electron app, which is why `agents.botfleet.app` returns 502 whenever the app is closed (IO21), and the iOS Sentry integration turns each 502 into an event, which is what pages PagerDuty (IO10).  The deployed Worker points at `botfleet.com` while everything else pins `botfleet.app` (IO22).  On the phone, every foreground does a full fleet download that wipes paged scrollback (IO12, IO13) and every streamed token re-renders the whole app (IO18, IO19).
4. **Engines waste turns and observability is partly dark.**  Ten of about seventeen engines have no transient retry (DR2); ACP engines and Codex spawn a fresh process and replay history every turn (DR3); the Chief of Staff's live roster text defeats Claude session reuse (DR1); Antigravity turns are serialized process-wide (DR4); the HTTP-lane `read_file` can inject a whole file into a transcript that is replayed every round (DR5); the quota poller spawns a broken CLI 1,440 times a day with no backoff (OP3, HS13).  The packaged app's Sentry SDK cannot load at all (OP1), the Usage Monitor outbox treats 409 as retryable and has already dropped 32 batches (OP2), the harness log has no timestamps or rotation (OP7), and the renderer burns CPU while idle because four avatar sites missed the animation gate the roster already has (UI1).

Host context: the Mac is at 95.8% swap, 12 GB free disk, and a load average near 200, mostly from other agent harnesses and WebKit, while the resource watch's cooldowns keep the Housekeeper asleep (OP6).  BotFleet is a contributor, not the cause, but it is the one process tree this report can shrink.

The ranked list in "What To Fix First" orders the work; "Problems With No Identified Fix Yet" names what needs a decision rather than a patch.

## Live Host State

Measured Thu, Sep 24, 2026 between 1:50 pm and 2:10 pm CT on the owner's Mac (uptime 2 days 7 hours).

| Signal | Value | Why it matters |
|---|---|---|
| Swap | 21.1 GB of 22.0 GB used (95.8%) | The box is paging; every BotFleet process pays for it |
| Disk free | 12.2 GB (97% used) | Below the 80 GB warn line and the 65 GB pressure line the resource watch is built around |
| 1-minute load | 172 to 221 | Kernel, `secd`, `WindowServer`, and `suggestd` dominate CPU; this is swap thrash, not bot work |
| `node` processes machine-wide | 84 | Four are children of the BotFleet harness; the rest belong to other agent harnesses on the same Mac |
| BotFleet harness (`app.botfleet.server`, pid 17229) | 486 MB RSS, 0% CPU idle, 9 child processes | Running from the detached `~/apps/botfleet-server` checkout under launchd |
| BotFleet.app renderer helper (pid 10885) | 776 MB RSS, 12.3% CPU while idle | The renderer burns CPU with no turn running and the window in the background |
| BotFleet.app companion sidecar (pid 10886) | 44 MB, listening on `*:8810` (all interfaces) and `127.0.0.1:8811` | The iOS path depends on this Electron-owned process, so it is down whenever the app is closed |
| BotFleet.app main (pid 10722) | 80 MB, serving the bundled UI on `127.0.0.1:18799` for the harness on `8799` | Two HTTP servers for one UI |
| `com.jay.mac-resource-watch` | last exit status 1; log says `cleanup cooldown 12860s remaining` and `webhook cooldown 6542s remaining` while reporting `disk_free_gb` and `load_1m` hits every 5 minutes | The Housekeeper bot is not woken while the host is drowning |

## Harness Log Analysis

`~/Library/Logs/botfleet/server.log` holds 8,020 lines from Mon, Sep 21 8:32 pm CT to Thu, Sep 24 6:51 am CT.  Lines written by the harness itself carry no timestamp; only the companion sidecar's lines do.  Counts by tag:

| Tag | Lines | What the lines say |
|---|---|---|
| `[companion err]` | 6,005 | 6,003 are `APNs 0 SendFailed`, one every ~40 seconds around the clock (80 to 115 per hour).  Two say `APNs refused the signing key (InvalidProviderToken); pushes are off until the key file changes`.  Pushes are off and the sender keeps logging a zero at error level. |
| `[antigravity-quota]` | 350 | 262 `poll failed: Command failed: antigravity-usage quota --json`, 81 with `--refresh`, 10 `Unexpected end of JSON input`.  The poll keeps running a CLI that keeps failing. |
| `[telemetry]` | 279 | 104 `Usage Monitor returned HTTP 409`, 33 `HTTP 503`, 2 `HTTP 429`, 1 `HTTP 500`, 91 `dispatch failed (TimeoutError)`, 25 `dispatch failed (TypeError)`, 23 `ambiguous acknowledgement`. |
| `[infisical]` | 47 | Flaps between `enabled env=prod` (17) and `disabled: not configured` (27) in runs, which means the machine identity is present on some boots and absent on others. |
| `[sentry]` | 24 | `disabled: no DSN configured` on 19 boots; twice `misconfigured (infisical): Sentry SDK failed to load: Dynamic require of "util" is not supported`.  The packaged server cannot load the Sentry SDK when a DSN is present. |
| `[err]` | 48 | Telemetry failures plus 16 stack frames from `/Applications/BotFleet.app/Contents/Resources/server/index.js`. |
| `[credentials]` | 14 | `workspace restoration unavailable; will retry` and `busy; will retry`. |
| boot and attach lines | 29 | 29 harness boots or desktop attaches in about two days. |

## Data Directory Growth

`~/.botfleet` is 3.5 GB.

| Path | Size | Observation |
|---|---|---|
| `native/` | 1.2 GB, 209 files (201 live, 8 rotated), 11 at the 64 MB cap, 188 untouched for 7+ days | The per-thread 64 MB cap from PR #373 holds, but there is no global cap and no age-based pruning, so dead threads keep their 64 MB forever |
| `workspaces/` | 1.9 GB across 103 directories, 85 untouched for 7+ days | One workspace is 1.7 GB because a bot cloned Socratic.Trade (1.1 GB) and three other repos into it; nothing garbage-collects stale workspaces |
| `messages.db` | 251 MB, 58,532 rows in `messages`, 76 in `thread_state` | No retention policy or `VACUUM` |
| `events/` | 143 MB, 202 files, 179 untouched for 14+ days | Per-thread event logs are never pruned |
| `routines.json` | 5.3 MB | Whole-file JSON, rewritten on change; it reached 35.7 MB on Sep 12 and stalled the event loop |
| `webhooks.json` | 3.0 MB | Same pattern as `routines.json` |
| `*.bak-*` copies | about 90 MB, 36 files | Ad-hoc backups of `bots`, `routines`, and `webhooks` JSON left behind by agents inside the live data directory |
| `attachments/` | 26 MB, 47 files | Fine today; no retention |

## Engine Drivers And Tools

Worker scope: `server/drivers/**`, `server/tools/**`, auto-approve, auto-review, chief-of-staff, CLI probing.  Read in full: `contracts.ts`, `claude.ts`, `acp/core.ts`, `acp/dsh.ts`, `antigravity.ts`, `chat-completions/*`, `retry.ts`, `tools/registry.ts`, `tools/agents.ts`, `tools/computer.ts`; targeted reads of `codex.ts`, `minimax.ts`, `openai-compat.ts`, `grok.ts`, `local-inject.ts`.

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| DR1 | P1 | The Chief of Staff roster text embeds each teammate's live busy state, and that text is part of the Claude driver's spawn fingerprint, so any teammate flipping busy or idle between turns tears down the warm Claude process and respawns it with `--resume`.  The bot BotFleet is designed around gets the least benefit from session reuse. | `server/chief-of-staff.ts:26-55`; `server/drivers/claude.ts:628` (`--append-system-prompt`), `:729-736` (`argsKey`), `:756` ("spawn contract changed") | New.  Fix: keep volatile fields out of the string that feeds `argsKey`, or respawn only when membership changes |
| DR2 | P1 | Ten of about seventeen engines have no transient-failure retry.  `acp/core.ts` (Cursor, Droid, Grok CLI, Hermes, Kimi, DeepSeek, Qwen, OpenCode, DSH) and `antigravity.ts` never call `classifyError` or `computeBackoff`; `claude.ts` and `codex.ts` do.  One 429 or connection reset fails the whole turn and pushes the fallback chain into a cooldown that a retry would have avoided. | `server/drivers/acp/core.ts` (single hit, a comment at `:1031`); `server/drivers/antigravity.ts` (none); compare `claude.ts:1003`, `codex.ts:639`, `retry.ts:8-11` | New.  Fix: reuse `retry.ts` in ACP core and Antigravity |
| DR3 | P1 | Every ACP engine and Codex spawns a fresh child per turn and replays the full session history each time (`session/load` or `session/new`, up to 120 s each, plus a 60 s init).  Only `claude.ts` keeps a warm process per thread and sends just the new text.  Long threads pay minutes before the model starts. | `acp/core.ts:519-530`, `:872-893`, `:270-274`; `codex.ts:234`, `:582`; compare `claude.ts:472-524`, `:741` | New.  Direction: the Claude driver is the target shape; whether each CLI supports a kept-alive stdio session needs CLI-side verification |
| DR4 | P1 | Antigravity's MCP-mount mutex is module-global and held for the child's entire lifetime, so every Antigravity turn in the process is serialized, even turns with no computer, for up to the 10-minute print timeout or the 11-minute watchdog. | `antigravity.ts:200`, `:636`, `:713-728`, `:662`, `:967-977` | New.  Fix direction: release the lease once the child has read the MCP config, if `agy` does not re-read it mid-turn |
| DR5 | P1 | The HTTP-lane `read_file` tool reads the whole file synchronously and returns all of it when the model omits `limit`; the result is embedded in the transcript, which the chat-completions engines replay in full on every later round and turn. | `server/tools/computer.ts:166-178`; `tools/registry.ts:518-547`; `chat-completions/loop.ts` `runToolBatch` pushes content verbatim | New.  Fix: default `limit` and cap returned bytes |
| DR6 | P2 | Chat-completions transcript replay is unbounded on MiniMax, OpenAI-compatible, and Grok API engines. | `minimax.ts:517`, `openai-compat.ts:398`, `grok.ts:202-215` | Fixed after the audit commit: PR #543 merged Sep 24 (issue #540 closed) |
| DR7 | P2 | `retry.ts` classifies CLI stderr with bare three-digit regexes (`\b429\b`, `\b5\d{2}\b`, `\b40[13]\b`) and generic words (`billing`, `subscription`), so a byte count, port, or PID can mark a working engine as quota-capped or retry a terminal failure.  The HTTP lane already uses the real numeric status. | `retry.ts:37`, `:39`, `:50`, `:55`, `:58-60`; compare `chat-completions/errors.ts:27-33` | New.  Fix: require status-adjacent context or structured fields |
| DR8 | P2 | Antigravity never fills `cachedInput`, so cache-read tokens are invisible to cost bookkeeping. | `antigravity.ts` usage sites near `:844-896` vs `contracts.ts:129`, `claude.ts:922-931` | Fixed after the audit commit: PR #544 merged Sep 24 (issue #542 still shows open) |
| DR9 | P2 | `ask_bot` on the HTTP lane inherits the uniform 90 s per-tool clock with no override, tighter than the 3-minute ceiling the fleet already documents; nothing in the tool prompt steers the model to `delegate_bot`. | `chat-completions/loop.ts:132`, `:456-474`, `:510`; `tools/agents.ts:283-325`; `registry.ts:175-176`; verified no override anywhere in `server/` | New.  Fix: per-tool timeout override for `ask_bot`, and prompt text that prefers `delegate_bot` |
| DR10 | P3 | The static Antigravity catalog was left out of the September 18 catalog refresh (PR #485 touched four catalogs, not this one) and still describes `agy` 1.1.23 while the driver references 1.1.26. | `server/antigravity-models.ts` header; `git show --stat 9b0a71c2` | New; only affects the fallback path when the live settings read fails |
| DR11 | P3 | All 34 harness tools are `http: true`, so the full schema list rides on every chat-completions request, up to 12 rounds per turn. | `tools/registry.ts` | Inherent to the stateless API; note only |

What looked right: auto-review is opt-in, bounded to 8 s, and runs on a separate Haiku process (`auto-review.ts:29-43`, `claude.ts:1177-1236`); the roster prompt is capped at 40 bots with clipped fields (`chief-of-staff.ts:17-20`).

## iOS Companion, Sidecar, And Hosted Path

Worker scope: `ios/**`, `companion/**`, `cloudflare/control-plane/**`, `shared/**`, plus `docs/ios-companion.md` and the two prior iOS audits.  Live checks by the coordinator: the installed `/Applications/BotFleet.app` is 1.0.31, its packaged sidecar (`Contents/Resources/companion/apns.js`) contains the PR #525 breaker code, and the harness attach lines stamp builds `e3923319` (Sep 23) and `ad758edf` (Sep 24).

### Push Path (`companion/src/apns.ts`)

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| IO1 | P0 | Transport failures (`status: 0`, `SendFailed`) are the only outcome class with no dedupe, so a broken link logs one error line per attempt cycle forever.  The ~40 s period is three attempts with 1 s and 2 s backoff plus three connect timeouts, and `drain` shifts the next queued alert as soon as one returns.  This produced all 6,003 lines. | `apns.ts:1629` (unconditional tail of `recordOutcome`) vs `:1615-1626` (`firstTime()` for 410, 400, 403); `:1041-1043`, `:1088-1096`, `:292`, `:340-342`, `:1633-1645` | New.  Fix: route `status === 0` through `firstTime()` keyed on device and failure kind; clear on `recordSent` |
| IO2 | P0 | Pushes are latched off after `InvalidProviderToken`, but the latch is a process-local `let`, so every Electron relaunch resumes full-rate sends with a key Apple already refused.  The phone's Settings row still says "Closed-app notifications: On" because it keys on `lastSentAt`, not on the breaker or failure kind.  Push has been dead since at least Sep 21 and every surface says otherwise. | `apns.ts:1405-1414`, `:1478-1481`, `:1716-1719`; `ios/Sources/CompanionCore/PushSenderHealth.swift:87-93` | New.  Fix: persist the key fingerprint and fault beside the device registry; make the summary check `circuitOpenUntil` and `failureKind` |
| IO3 | P1 | An open circuit destroys queued alerts instead of deferring them: `drain` shifts the alert before `sendOne` discards it, emptying the backlog in one loop.  A blocking approval queued during a 60 s open window is never delivered. | `apns.ts:1519-1531`, `:1641` | New.  Fix: `unshift` back onto the lane and break the drain |
| IO4 | P1 | The circuit-open warning dedupe key embeds `consecutiveTransportFailures`, which only resets on success, so the key never matches, a new warning is logged on every trip, and the `Set` grows without bound. | `apns.ts:1577-1579`, `:1423-1427`, `:1256` | New.  Two-character fix |
| IO5 | P1 | The breaker state is invisible on the phone: the server sends `failureKind`, `consecutiveTransportFailures`, `lastErrorCode`, and `circuitOpenUntil`, and the Swift decoder drops them. | `apns.ts:1140-1162` vs `PushSenderHealth.swift:9-33`; Mac side is fine at `control.ts:437-452` | New |
| IO6 | P2 | Key rotation after a key fault reuses the stale provider token and TLS sessions, so a replacement `.p8` is signed against the old cached token and is refused again, permanently. | `apns.ts:1408`, `:1450-1457` | New |
| IO7 | P2 | Every alert carries `content-available: 1`, and each wake performs a full fleet download (`fleet(messages: 50)` for every bot) on cellular. | `apns.ts:222`; `CompanionApp.swift:101-125`; `Session.swift:1332-1337`; `Client.swift:640-643` | New.  Fix: a silent variant that refreshes only the affected thread |
| IO8 | P3 | `mutable-content: 1` is set with no Notification Service Extension target. | `apns.ts:221`; `ios/project.yml:26-144` | New |
| IO9 | P2 | No load shedding when no phone holds a token. | `docs/audits/2026-09-22-apn-transport-review.md` § Future Work | Tracked |

Coordinator note: the log shows the transport-failure loop ran at 63 to 115 lines per hour on a build that already contained the breaker, and stopped only at 4:20 am CT on Sep 24, after which the two `InvalidProviderToken` lines appear (one per sidecar generation).  The breaker did not slow the loop because it never trips:

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| IO1b | P1 | The circuit breaker cannot open in practice.  `consecutiveTransportFailures` is one counter shared across every device and failure kind, and `recordError` resets it to zero on any non-transport outcome.  `deliver` fans each notification out to every disconnected token, so one interleaved `400 BadDeviceToken`, `503`, or `500` from another phone zeroes the run.  At about 40 s per send the threshold of 20 needs 13 unbroken minutes, so the observed rate (about 90 per hour) is the never-opens rate; a working breaker would be about 36 per hour.  Separately, `http2_protocol` increments the counter but is excluded from the transport branch, so a GOAWAY on the twentieth iteration skips the trip. | `apns.ts:1041-1043`, `:1208`, `:1267-1272`, `:1547`, `:1573-1580`, `:1574`, `:1690-1710` | New.  Fix: count per device, count only the transport family, include `http2_protocol` in the branch.  Decisive live check: read `consecutiveTransportFailures` and `failureKind` on the pairing page (`control.ts:437-452`) |


### iOS Network Layer

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| IO10 | P0 | Sentry captures one `HTTPClientError` per 5xx response with no dedupe or ignore list, and arms a session-replay upload on the first error.  A Mac-offline window therefore produces dozens of events, trips metric alert BOTFLEET-B, and pages PagerDuty (Sep 8, 15, 17). | `ios/App/SentryTelemetry.swift:18-19`, `:24`, `:27-40`; `SSE.swift:105-107` | New.  One-line fix: ignore 502/503/530 from the paired companion host in `beforeSend` or `ignoredHttpStatusCodes` |
| IO11 | P1 | Reconnect backoff caps at 15 s with no jitter, no attempt ceiling, and no "Mac is offline" state; 502 is treated as a route failure so the rotation walks and retries.  A 24-minute outage is about 96 attempts. | `Session.swift:720-721`; `Failover.swift:129-136` | New.  Fix: jitter, a 60 s cap after repeated gateway errors, and a distinct offline status |
| IO12 | P1 | Every hydration wipes all paged-in scrollback (`messages.removeAll()`) and rebuilds from the 50-message page, so a user who loaded ten pages loses them on every foreground, push wake, or unresumable reconnect and re-downloads. | `Store.swift:203-206` | New.  Fix: merge the page into existing threads |
| IO13 | P1 | Every foreground does a full fleet hydrate in addition to the SSE cursor resume, which already covers the gap. | `LiveActivities.swift:68-79`; `Session.swift:1344-1377` | New.  Fix: skip the hydrate when the hello frame reports `resumed: true` |
| IO14 | P2 | No conditional requests anywhere (no `ETag`, `If-None-Match`, or `Last-Modified` in `ios/`, `companion/`, or `server/`), and the sidecar only forwards `accept`, `content-type`, and `last-event-id`, so the header could not survive anyway. | `companion/src/proxy.ts:215-230` | New |
| IO15 | P2 | No compression on the sidecar-to-harness leg and none at all on LAN or Tailscale; the full-fleet JSON goes out uncompressed. | `proxy.ts:215-230`, `:512-518` | New |
| IO16 | P2 | All non-streaming calls use `URLSession.shared` with default configuration, and the sidecar forces `no-store` on every response, so avatars and screenshots are never cached on the phone. | `Client.swift:378`, `:1323-1330`; `proxy.ts:129-135` | New |
| IO17 | P3 | The push token is re-posted on every launch with no dedupe. | `CompanionApp.swift:47-49`; `Session.swift:942-944` | New |

Ruled out: JSON decoding is off the main actor (`Client.swift:373`).

### Battery And UI

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| IO18 | P1 | Every streaming token mutates the single published `CompanionState` struct, so each delta re-evaluates both the chat list and the chat view. | `Session.swift:39`; `Store.swift:20`, `:432` | New.  Fix: publish `streaming` through a separate lightweight object or throttle to ~20 Hz |
| IO19 | P1 | The roster recomputes an O(threads × transcript) derivation inside `body` on every one of those publishes (`pendingApprovals` calls `visibleTranscript` per thread, which rebuilds a dictionary and walks the parent chain), and `chatSummaries` is filtered four times in the same body. | `ChatListView.swift:345`, `:528`, `:567`, `:575`, `:605`, `:644`, `:666`; `Store.swift:77-95`, `:182-191` | New.  Fix: memoize against `hydrationRevision` (`Store.swift:62-64`) |
| IO20 | P2 | The transcript is a non-lazy `VStack` that grows with every "Load earlier" page. | `ChatView.swift:232-253` | New |

Ruled out (good code): the animated avatar is opt-in, pauses when the scene is inactive, and respects Reduce Motion; Live Activity sync is debounced; `Activity.request` is off the main actor; the avatar cache is bounded.

### Sidecar, Hosted Gateway, And Worker

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| IO21 | P0 | The companion sidecar lives and dies with the Electron app; nothing runs it under launchd, so the hosted route `agents.botfleet.app` returns 502 whenever the app is closed or an update fails.  This is the root cause the Sentry pager storm amplifies. | `electron/companion.mjs` spawns `companion/src/index.ts`; no plist in the repo runs it | Incidents tracked (Sep 8, 15, 17); no issue.  Decoupling needs the guardian (`electron/managed-companion-guardian.mjs`) and a stable origin socket (`companion/src/origin.ts`) moved with it: a design change, not a plist.  Interim: have the Worker return a distinguishable status (523 plus JSON) when the origin is down so the phone enters a long-backoff offline state |
| IO22 | P1 | The deployed Worker config routes `accounts.botfleet.com` with `COMPANION_HOST_SUFFIX: "botfleet.com"`, while the desktop pins `botfleet.app` and the iOS entitlement claims `applinks:botfleet.app`.  Endpoints provisioned by this Worker would be rejected by the desktop and uncovered by universal links. | `cloudflare/control-plane/wrangler.jsonc`; `electron/companion-account-service.mjs:21`; `ios/project.yml:103-105`; `docs/ios-companion.md` | New |
| IO23 | P2 | The Bonjour responder withdraws, rebinds, and re-announces on every IPv4 set flap on a 30 s tick; a VPN or bridge interface appearing and vanishing re-announces network-wide each time (the log shows repeated advertising lines). | `companion/src/advertise-watch.ts:45`, `:60-89`; `index.ts:118-124` | New |
| IO24 | P3 | `authenticate()` runs two or three times per request and stamps `lastSeenAt` each time. | `proxy.ts:248`, `:321`, `:426`; `index.ts:156-157` | New |
| IO25 | P3 | The packaged app ships `companion/apns.test.js` inside `Contents/Resources/companion`. | installed bundle listing | New; packaging hygiene |

Ruled out: `*:8810` is a deliberate, documented, authenticated paired-device surface (`companion/src/index.ts:9-11`, `:247`; `proxy.ts:243-258`; `routes.ts:256-258`).  The request path is phone → Cloudflare edge → `cloudflared` → gateway `:8812` → sidecar → harness; auth is checked once at the sidecar and the harness trusts loopback, so the cost is hops and the 32 MB JSON buffering for scrubbing (`proxy.ts:530-576`), not repeated auth.

### README And Docs Versus Code (iOS)

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| IO26 | P1 | "Unread Live Activities" cannot exist: every activity is ended on background and `pushType` is nil. | `LiveActivityLifecycle.swift:45-50`; `LiveActivities.swift:58`, `:81-91`, `:222`; README line 25 | Tracked: issue #294, board `699ea1ae` |
| IO27 | P2 | "App Groups" is an entitlement with no code behind it; the widget target contains only the Live Activity configuration. | `ios/App/BotFleet.entitlements:16`; `BotFleetWidgets.swift:16-18` | New |
| IO28 | P3 | "Display-aware transcript windows" is not what the code does; `visibleTranscript` selects the active branch and the view renders everything loaded. | `Store.swift:77-95`; `ChatView.swift:232` | New |
| IO29 | P3 | `docs/ios-companion.md` still says the light color scheme is pinned; it was removed on Sep 19. | `CompanionApp.swift:36-41` | Doc drift |
| IO30 | P2 | App thinning is disabled globally, so every device downloads every asset variant. | `ios/project.yml:15-16` | New |

Prior iOS audit reconciliation (Sep 9 and Sep 22): fixed in code are the profile PATCH trust boundary (`routes.ts:50-76`, `proxy.ts:340-354`), "Always Allow" removal, background-APNs navigation gating (`BackgroundRefresh.swift:52-59`), background fetch completion (`CompanionApp.swift:115-124`), thread binding and idempotency keys on sends (`Client.swift:1063-1095`, `:444-462`), attachment format parity, effort preservation (#541), the HTTP/2 transport, the swallowed transport error, the `InvalidProviderToken` timestamp, and the Mac-side health surface.  Still open: Live Activities while suspended (#294) and the phone-side health surface (IO5).  Could not verify: settings form dismissal on failed save.

## Operations, Updater, Telemetry, And CI

Worker scope: `scripts/**`, `.github/workflows/*`, `cloudflare/*/wrangler.jsonc`, `server/telemetry*.ts`, `server/antigravity-quota.ts`, `server/infisical.ts`, `server/sentry.ts`, `server/observability.ts`, `scripts/mcp-server.ts`, `server/recall-tools.ts`, the live host copies under `~/apps`, and the LaunchAgent plists (keys only).

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| OP1 | P1 | The Sentry SDK cannot load in the packaged app.  `server/sentry.ts` dynamic-imports `@sentry/node`, and the esbuild ESM bundle of the server turns that into `Dynamic require of "util" is not supported`; the failure is caught and logged as `misconfigured`, so no packaged install can ever report to Sentry regardless of DSN source.  The team already fixed this exact class for `yaml` with a dedicated plugin and never did it for Sentry. | `server/sentry.ts:194`; `server/observability.ts:219`; `scripts/bundle-server.mjs:30-41`; log lines at 7:04 am and 4:51 pm CT on Sep 22 from the packaged app | New.  Fix: externalize `@sentry/node` from the bundle or apply the `yaml` treatment |
| OP2 | P1 | The Usage Monitor outbox is head-of-line blocking and never treats HTTP 409 as terminal: any non-2xx becomes a retry with exponential backoff on `queue[0]`, the loop returns without trying newer batches, and once 500 batches accumulate the newest are silently dropped.  The live outbox already records 32 dropped batches, 32 overflow drops, and 557 failed attempts. | `server/telemetry.ts:644-653`; `server/telemetry-outbox.ts:207-210`, `:319-357`; `~/.botfleet/usage-telemetry-outbox.json` counters | New (adjacent to #542).  Fix: treat 409 and other never-succeed 4xx as droppable; let the loop skip a poisoned head.  The 25 `TypeError` dispatch failures are a client-side exception worth their own look |
| OP3 | P1 | The Antigravity quota poller runs `antigravity-usage quota --json` every 60 s with a 20 s timeout and no backoff; the catch block logs and continues forever.  With the CLI broken this is one error line per minute (353 so far), plus 10 truncated-JSON outputs that point at a second bug in the CLI itself. | `server/antigravity-quota.ts:51`, `:309`, `:338-349` | New.  Fix: exponential backoff after N consecutive failures, the pattern `telemetry-outbox.ts` already uses |
| OP4 | P1 | `prepare-cloudflared.mjs` still does a single 120 s fetch with no retry and no default cache, and its only cache directory comes from an environment variable nothing sets.  The sibling `prepare-android-tools.mjs` got 10-minute timeouts, 3 attempts, and a shared cache in PR #446 for the same incident, and that commit message names both downloads.  The Sep 17 update outage came from this script and the code is unchanged.  Separately, the Mac updater path calls `build:cloudflared` without `--current`, so every self-update downloads both darwin-arm64 and darwin-x64 and throws one away. | `scripts/prepare-cloudflared.mjs:54-59`, `:200-209`; `scripts/prepare-android-tools.mjs:26-28`, `:44-52`; `package.json` `build:cloudflared`; `update-botfleet-mac.mjs:1513-1519` | New.  Fix: port the retry and shared-cache pattern; pass `--current` |
| OP5 | P1 | The host copy `~/apps/update-botfleet.sh` is about 170 lines behind the tracked `scripts/update-botfleet.sh`: it lacks the "bootstrap the updater from the target commit" block that the code comment calls load-bearing during a signing-identity or bundle-identifier transition.  The bundle-ID rename (PR #524) is still open and the rollout order in `docs/rollouts/2026-09-22-updater-transition-bootstrap.md` requires the transition wrapper on every Mac first. | diff of host vs tracked `:158-315`; `update-botfleet-mac.mjs:32-40` | New.  Fix: reinstall the wrapper from tracked HEAD before PR #524 lands |
| OP6 | P1 | `mac-resource-watch.py` has independent cooldowns (webhook 4 h; cleanup 2 h, 30 min when critical) and triples its own cleanup cooldown when a run frees nothing, with no ceiling on total silence and no escalation path.  Today it sees disk and load hits every 5 minutes while both cooldowns sit for hours.  Its exit status 1 is the script's own "hit but nothing fired" signal, not a crash; the plist has no `KeepAlive`, so it simply reports until the next tick. | `~/apps/mac-resource-watch.py:45`, `:51-52`, `:407-409`, `:424`; `com.jay.mac-resource-watch.plist` | New.  No fix identified yet beyond a faster independent alert path or a hard ceiling on silence |
| OP7 | P2 | `server.log` is one unrotated append-only file (stdout and stderr share the path) with no `newsyslog` entry, growing monotonically, and only companion lines carry timestamps; harness `[telemetry]`, `[antigravity-quota]`, and `[infisical]` lines carry none, so incidents cannot be correlated across subsystems. | `com.jay.botfleet-server.plist:23-26`; observed growth 566,774 to 570,547 bytes in 20 minutes | New.  Fix: wrap `console` once at boot with a timestamp; add size-based rotation |
| OP8 | P2 | CI runs the 20-minute `macos-latest` iOS job and the 25-minute Ubuntu package-and-smoke job on every non-docs push or PR; the `changes` job classifies only docs-only versus everything else, with no per-area path filter.  A Worker-only change pays the full three-OS matrix, control plane, Linux packaging, and an iOS build.  Five of the last twelve CI runs were cancelled by concurrency after 6 to 13 minutes of paid runner time. | `.github/workflows/ci.yml:20-50`, `:122-127`, `:206-211`; `scripts/ci-change-scope.mjs` | New.  Fix: per-area filters (`ios/**`, `electron-builder.yml`, `third_party/**`) feeding job-level `if` |
| OP9 | P2 | `ios-ship.yml` runs on `macos-latest` every 30 minutes around the clock with a full-history checkout, about 48 runs per day, because bot merges do not fire `push`.  A cheap gate step exits early when nothing changed, so the design is close to minimal, but the fixed cost is permanent. | `.github/workflows/ios-ship.yml:38-41`, `:47-58`, `:87-95` | Known design; note only |
| OP10 | P2 | The launchd wrapper exits 1 when `node_modules` is missing and `KeepAlive.SuccessfulExit=false` with `ThrottleInterval` 5 retries forever at roughly every 5 to 7 s with no cap or alert; the disk janitor has deleted that directory twice. | `scripts/botfleet-server-start.sh:23-27`; plist keys | New.  No fix identified yet; a retry cap or a distinct "needs a human" exit would help |
| OP11 | P3 | `bootLine()` for Infisical prints at boot and again inside the Settings PATCH handler whenever the patch carries an `infisical` block, so every settings save that includes an unchanged block logs "disabled: not configured".  This Mac genuinely has no machine identity configured, so the state is real and the cost is a log line, not a request. | `server/index.ts:390`, `:11103-11111`; `server/infisical.ts:94`, `:189-195`, `:486` | New; low |
| OP12 | P3 | `.tmp-pr-body.md` (72 lines) is a tracked scratch file at the repo root, committed with PR #528. | `git log a7d6a4f4` | New.  Delete and ignore |
| OP13 | P2 | Each seat worktree carries its own `node_modules`; the always-on checkout alone is 2.1 GB, and about 23 BotFleet worktrees exist on this Mac. | `du -sh ~/apps/botfleet-server/node_modules` | See the hygiene section |

Confirmed working as intended: the two-phase updater only quiesces the live app after the runtime fence, so a prepare-phase download failure no longer takes the app down (`mac-update-transaction.mjs:52-75`), and rollback relaunches the prior bundle (`update-botfleet-mac.mjs:2032-2045`); the `ubf` no-op shortcut is sub-second; `postinstall` does no network work; the MCP server caches its discovered base URL; recall tools use a TTL cache for reads; the `jay`-account iMessage relay plist is disabled on disk; the Composio broker and control plane Workers use current compatibility dates, D1, and native rate limits.

Not verified within budget: `electron/managed-companion-tunnel.mjs` and `managed-companion-guardian.mjs` restart and backoff correctness, `release.yml` signing and feed generation (issue #285 tracks the feed), Worker per-request costs, and the `agents`-account iMessage listener (unreadable from this seat).

## Web Renderer And Electron Shell

Worker scope: `src/**`, `electron/**`, `vite.config.ts`, the built `dist/assets` chunk list, and the live `updater.log`.  The worker took its own samples of the idle renderer: 62% cumulative average CPU since the 6:50 am launch and 16% instant, at 375 to 769 MB RSS.

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| UI1 | P1 | Mascot avatars outside the roster run an uncapped 60 fps `requestAnimationFrame` loop forever.  The same bug was fixed for the roster (`animated` only when busy, unread, or motion is on) and for every avatar in `GroupView`, but not for the open chat's header avatar, the empty-thread avatar, or the two bot-to-bot comm-chip avatars, and the comm chip is rendered once per bot-comm message in the 120-item transcript window, so a thread with many handoffs mounts dozens of permanent loops for settled messages.  This is the best single explanation for the idle renderer CPU. | `src/components/Avatar.tsx:159`; `CursorAvatar.tsx:1553-1589`; `ChatView.tsx:621`, `:647`, `:742`, `:1351-1357`; compare `Sidebar.tsx:1654-1658`; `src/lib/transcript-window.ts:10` | New.  Fix: apply the roster's `animated` rule at the four sites |
| UI2 | P1 | No code splitting anywhere in the renderer: `App.tsx` statically imports Settings, Group Settings, Plugins, Computer, Routines, Command Palette, Local VM, Skill Recorder, and Team Map, so all of it ships in the 2,080 KB main chunk even though each is already conditionally rendered. | `src/App.tsx:1-25`, `:335-340`; no `React.lazy` in `src/` | New.  Fix: `React.lazy` plus `Suspense` at the existing conditional boundaries |
| UI3 | P1 | Sentry (tracing, replay, feedback) and PostHog are statically imported into the main chunk; only activation is runtime-gated, not inclusion. | `src/lib/sentry.ts:16`; `src/lib/analytics.ts:8` | New.  Fix: dynamic `import()` behind the same runtime checks |
| UI4 | P2 | The desktop updater retries a permanently broken release every hour forever: a failed check never records a successful auto-check, so the 6-hour throttle never engages.  The live `updater.log` shows 67 consecutive hourly `HttpError: 404` failures from Sep 22 through Sep 24 because release v0.1.38 ships DMGs without `latest-mac.yml`; each failure logs a full stack trace and shows nothing to the user. | `electron/updater.mjs:30-31`, `:265-273`, `:297-306`; `electron/updater-coordinator.mjs:16-19`, `:85-94`; `docs/releasing.md:39-45` | Release feed tracked in issue #285; the retry-forever behavior is new.  Fix: back off or stop after N consecutive automatic failures until a manual check or restart |
| UI5 | P2 | The sidebar roster filter and sort (with a lowercase `preview()` per bot) runs in the component body on every store dispatch, not in `useMemo`, so every SSE event re-sorts the roster. | `src/components/Sidebar.tsx:2230-2266`; compare the memoized `MessagesList` at `ChatView.tsx:694`, `:730-733`, `:1047-1053` | New.  Fix: `useMemo` on bots, groups, and the query |
| UI6 | P2 | PostHog initializes unconditionally on mount, before and independent of onboarding, defaults to on unless the user opted out in Settings, and fires `app_first_open` and `app_opened` to `us.i.posthog.com` on first run.  `docs/ios-privacy.md` says "no product-analytics SDK" for the iOS app only; the desktop claim is easy to over-read. | `src/App.tsx:349-353`; `src/lib/analytics.ts:70-94`; `docs/ios-privacy.md:36` | New.  Product decision, but an unconditional startup network call; clarify the doc scope |
| UI7 | P3 | The sidebar phone-pairing poll (15 s) has no page-visibility gate, unlike the computer and Android panels, which use `usePageVisible()`. | `src/components/SidebarPhoneButton.tsx:10`, `:146`; `src/lib/page-visible.ts` | New |
| UI8 | P3 | Shiki loads its WASM regex engine on the first code fence regardless of language; the lighter JavaScript engine variant would avoid the 608 KB `wasm` chunk. | `src/components/ChatMarkdown.tsx:78-83`; `dist/assets/wasm-*.js` | New; minor |
| UI9 | P3 | The transcript window bounds the DOM to the last 120 display items rather than virtualizing; a window of computer-use screenshots is still real DOM weight. | `src/lib/transcript-window.ts` | Note only |

Verified correct: SSE hydration has a real hello and resume boundary with a pending-frame queue and 1 s, 3 s, 10 s retry backoff, and streamed deltas flush once per animation frame (`src/state/store.tsx:2543-2816`, `:2729-2749`); Shiki re-highlights a growing fence after a 250 ms settle with a capped 200-entry cache (`ChatMarkdown.tsx:22-23`, `:98-112`); Shiki itself is lazy (`ChatMarkdown.tsx:78`); `lucide-react` icons are named imports; the elapsed turn timer is one interval for the active bubble only (`TurnPresence.tsx:31-40`); the saved skin is applied before first render; the attach-or-spawn harness logic attaches to the always-on harness with an ownership challenge instead of forking a second one (`electron/server-boot-probe.mjs:203-299`, `main.mjs:996-1034`); the second HTTP server on 18799 is the intended static shim for a headless harness (`main.mjs:1010-1034`); `powerSaveBlocker` is gated on explicit settings; closing the window destroys the renderer, so no polling survives a close; the menu-bar tray keeps the app alive on macOS (`main.mjs:2355-2361`); startup hydration is six parallel requests plus SSE, not a serial chain.

## Harness Server Core

Worker scope: `server/index.ts`, `store.ts`, `atomic.ts`, `message-db.ts`, `routines.ts`, `webhooks.ts`, `harness/bus.ts`, `harness/registry.ts`, `transcript-retention.ts`, `rolling-spend.ts`, `checkpoints.ts`, `workspace.ts`, `telemetry-outbox.ts`, `antigravity-quota.ts`, `grok-quota.ts`, `infisical.ts`, and the boot and shutdown paths.  The worker measured `JSON.stringify` of a 3.56 MB object with indentation at 30.4 ms on this Mac.

### Persistence And Disk Growth

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| HS1 | P0 | Transcript logs are capped per file but never reclaimed per thread.  The daily sweep only trims files over the cap; removal happens only on explicit deletes.  A thread that stopped being used keeps 64 MB plus 64 MB in `native/` and 16 MB plus 16 MB in `events/` forever, which is the observed 1.2 GB of exactly-64 MB files and 179 idle event files.  The ceiling is 160 MB per thread ever created. | `server/transcript-retention.ts:47`, `:52`, `:122`, `:312`; deletes only at `server/index.ts:8018`, `:8198`, `:8728`, `:9318`, `:9380` | New.  Fix: age and orphan sweep in the daily timer for ids not in the store; the only reader (`thread-events.ts:482`) wants the newest few hundred lines |
| HS2 | P1 | `messages.db` has no pruning and no `VACUUM`; `pruneScreenFrames` drops base64 pixels but rewrites the row in place, so freed pages stay in the file.  251 MB for 58,532 rows is about 4.3 KB per row, and every boot's `readThread` and the `LIKE` search scan pay for the dead pages. | `server/message-db.ts:165`, `:186`; `server/store.ts:1387`, `:1419` | New.  Fix: delete rows for dead thread ids and run `VACUUM` or incremental auto-vacuum |
| HS3 | P1 | Per-bot workspaces are created on every dispatch and removed only when a bot is deleted; they are the CLI's `cwd`, so clones and `node_modules` land there.  A bot deleted while the harness was down leaves its directory forever. | `server/workspace.ts:33`; `server/index.ts:3328`, `:4831`; `server/store.ts:1565` | New.  Fix: boot sweep for ids not in `bots.json`; size warning in Settings |
| HS4 | P1 | `routines.json` `save()` is neither durable nor collision-safe and blocks the loop about 45 ms per call at today's 5.3 MB: `writeFileSync` plus `renameSync` with no `fsync`, a fixed `.tmp` temp path that a launchd harness and an embedded harness can interleave on, indented output, and 18 call sites including every run-state transition and `markRunSeen`.  `atomic.ts` already does this right. | `server/routines.ts:406-1287` (call sites), `:1296-1327`; compare `server/atomic.ts:11` | New (adjacent to PR #535).  Fix: `writeFileAtomic`, a short debounce, no indent |
| HS5 | P1 | `webhooks.json` (3.0 MB) is fully serialized, fsynced, and renamed on every webhook receipt, from 10 call sites; it holds 2,000 deliveries and 2,000 attempts with a 2,000-character payload preview each, so a push storm is one 3 MB write per event on the request path. | `server/webhooks.ts:147-148`, `:298`, `:439-660`, `:691` | New (adjacent to #467 and #535).  Fix: lower retention, debounce, drop the indent, or move deliveries to sqlite |
| HS6 | P1 | `bots.json` is fully rewritten with fsync on every activity transition, from 25 call sites; a single `startTurn` fires at least three.  The file holds every task's resume cursors and per-instance usage, so it grows with history. | `server/store.ts:879`, `:1607`, `:1647`, `:1658`, `:1682`, `:1703`, `:1718-1725`; `server/index.ts:3237-3239` | New.  Fix: coalesce saves on a microtask or short debounce |
| HS7 | P2 | `errors.log` is appended synchronously on every runtime error and never rotated, while `decision-log.ts` already rotates at 4 MB asynchronously. | `server/index.ts:2306-2308`; compare `server/decision-log.ts:75-88` | New.  Fix: reuse `appendBounded` |
| HS8 | P2 | The telemetry outbox rewrites the whole queue (up to 500 batches) plus a directory fsync once per batch and once per failure, so draining a backlog is quadratic in bytes with 500 directory fsyncs. | `server/telemetry-outbox.ts:143-153`, `:341`, `:354`, `:395` | New.  Fix: persist once per flush loop or on a timer |
| HS9 | P3 | `scripts/merge-automation-tasks.mjs` writes `.bak-merge-<stamp>` copies into the data dir with no pruning; the rest of the 90 MB of backups are agent-made. | `scripts/merge-automation-tasks.mjs:65` | New |

### Event Loop Hazards

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| HS10 | P0 | Every runtime event is deep-cloned, run through seven or more global secret-redaction regexes with no input length cap, and appended to disk synchronously on the main thread.  The native tee carries whole file contents a tool read, so a 5 MB `read_file` result means a 5 MB clone, eight full regex scans, and a blocking append per event while every other bot's turn, the SSE fan-out, and `/api/health` wait.  This is the hottest path in the harness and it is fully synchronous. | `server/harness/bus.ts:88-105`; `shared/redact.ts:947`, `:1026`; `server/transcript-retention.ts:41` | New.  Fix: cap the redaction input (redact the head, mask the tail above N KB) and move the tee to an async append stream with a bounded queue |
| HS11 | P1 | Boot reads every events file with an mtime inside 7 days fully into memory and splits it on newlines for rolling spend; with 16 MB files that is a multi-second synchronous stall and about 3× transient RSS, repeated on each of the 29 boots seen in two days, with nothing cached between boots. | `server/rolling-spend.ts:34`, `:72-76`; `server/index.ts:434` | New.  Fix: stream lines and persist a file-plus-offset cursor |
| HS12 | P1 | `GET /api/bots` materializes every thread of every bot and group through `messagePage`, which loads the full thread from sqlite and caches it in `Store.threads` with no eviction (the only delete is on thread delete).  One hydrate against a 251 MB database pulls every thread into the heap for the life of the process.  This is the most likely driver of the 486 MB harness RSS. | `server/index.ts:1162`, `:7244-7252`; `server/store.ts:718`, `:985`, `:1339`, `:1354` | New.  Fix: LRU-evict `threads`; `LIMIT`-ed SQL read in `messagePage` |

### Timers And Polling

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| HS13 | P2 | The Antigravity quota CLI is spawned every 60 s forever whether or not any bot uses Antigravity, with `--refresh` (a Google network call) every fifth tick: 1,440 process spawns per day at idle, and every non-ENOENT failure logs with no dedupe. | `server/antigravity-quota.ts:277-288`, `:310-311`, `:334`, `:340`, `:359`; `server/index.ts:11512` | New (see OP3).  Fix: gate on a configured Antigravity instance; back off; dedupe |
| HS14 | P3 | The Grok quota poller ticks every 5 minutes to return a documented constant because the CLI has no quota subcommand. | `server/grok-quota.ts:185`, `:223`; `server/index.ts:11517-11523` | New.  Fix: compute once, drop the timer |
| HS15 | P2 | Screen capture runs every 6 s per busy bot even with zero SSE clients or none subscribed to screens, hitting the box or VPS command endpoint and broadcasting a several-hundred-KB base64 frame each time.  The module's own comment says every frame is latency stolen from the user's work. | `server/index.ts:1188`, `:2916-2920`, `:2948`, `:2961` | Fixed after the audit commit: PR #550 "Capture computer screens only while watched" merged Sep 24 (issue #545 still shows open) |

### SSE And Events

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| HS16 | P2 | SSE writes ignore the `write()` return value, so a stalled client (a phone on cellular that stops draining while screen frames stream) buffers without bound in the harness heap; there is no per-client cap or slow-client eviction. | `server/index.ts:1232-1239` | New.  Fix: drop screen frames for that client on `write() === false`, disconnect past a byte threshold |
| HS17 | P3 | The replay buffer is 500 full frames, capped by count only; screen frames are nulled but long `message` frames are not. | `server/index.ts:1206-1207`, `:1229-1231` | New.  Fix: cap by bytes too |

### Boot, Recovery, And Restart

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| HS18 | P0 | A clean SIGTERM during a turn is indistinguishable from a crash: the shutdown handler never clears `inflightThreadId`, the store deliberately keeps it on load, and 2.5 s after boot every eligible bot re-dispatches its turn at once with no stagger or cap.  With 29 boots in two days, every restart that catches a bot mid-turn re-spends a full CLI turn.  This is the Sep 19 `resume_failed` class and the retry-storm class the owner ruled on Sep 22. | `server/index.ts:4591-4593`, `:11620-11633`; `server/store.ts:751-754` | New.  Fix: clear or mark `inflightThreadId` on graceful shutdown; stagger and cap recovery fan-out |
| HS19 | P1 | The HTTP port does not open until Infisical preload, registry load, resume of interrupted turns, and a conditional provider rebuild have all finished, so `/api/health` connection-resets during boot by design; a slow network makes the Infisical path take its full 12 s cap before anything answers. | `server/index.ts:388`, `:399`, `:11548`, `:11577`, `:11586`; `server/infisical.ts:209-217` | New.  Fix: listen early and gate `/api/` (not health) behind a booting flag, as `runtimeQuiescing` already does at `:6858` |
| HS20 | P2 | Two resume paths can dispatch the same thread: `resumeInterruptedChatTurns` at module init and `recoverInflightTurn` 2.5 s later.  The busy guard covers the normal case; if the first dispatch fails fast and unwinds `busy` before the timer, the thread dispatches twice.  Inferred, not executed. | `server/index.ts:3237`, `:3247`, `:4525`, `:4591`, `:11548` | New.  Worth a targeted test |

### Memory

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| HS21 | P1 | `Store.threads` is an unbounded cache (see HS12). | `server/store.ts:718`, `:985`, `:1354` | New |
| HS22 | P3 | `toolMessageByItem` and `toolStartedAt` leak entries for tools that never complete; `turn.completed` clears other per-turn state but not these. | `server/index.ts:1248`, `:1253`, `:2030-2031`, `:2329` | New.  Fix: sweep by `threadId:` prefix on `turn.completed` |

### Retry, Backoff, And Cost

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| HS23 | P2 | No log dedupe on repeated failures in telemetry and the Antigravity poller; that is the 279 and 350 lines. | `server/telemetry.ts:644-646`; `server/antigravity-quota.ts:340` | New.  Fix: collapse repeats into "N failures since" |
| HS24 | P1 | A checkpoint snapshot (`git add .` over the whole project folder plus a commit) is awaited inside turn dispatch before the engine is invoked, and the shadow repo has `gc.auto = 0` with nothing that ever prunes or packs, so loose objects accumulate forever and every turn pays the add before the model is called. | `server/index.ts:3460`; `server/checkpoints.ts:132` | New.  Fix: periodic `git gc --prune` on idle shadow repos; cap checkpoint count |
| HS25 | P2 | Transcript replay is a flat last-40 text messages with no byte budget. | `server/index.ts:3183-3190` | Fixed after the audit commit: PR #543 merged Sep 24 |
| HS26 | P2 | The engine disk cache is written twice per probe with `writeFileSync` rather than the atomic writer, and `setDiskCachePath` stamps the loaded cache as probed-now, so callers passing `maxAgeMs` without stale-while-revalidate get a stale engine and model list with no revalidation. | `server/harness/registry.ts:322`, `:340`, `:367-369`, `:383`; `server/index.ts:663`, `:2692` | Cache warmth is PR #536's intent; the double write and freshness stamp are new |

Verified sound: retry paths in `server/` are capped and backed off (telemetry outbox 1 s to 300 s with a 500-batch queue; APNs 3 attempts); the daily transcript sweep is atomic and keeps whole newest lines; `transcript-retention.ts` honestly documents that nothing is deleted, which is exactly the gap in HS1.

## Prior Audit Reconciliation

The reconciliation worker read all nineteen documents under `docs/audits/`, the two findings JSON files, and the effort log, and checked every performance, efficiency, reliability, or feature-not-working finding against the code and GitHub state on Sep 24.  Of 72 such findings, 52 are fixed with a named PR, 4 were fixed on Sep 24 while this audit ran, 5 are still open, and 11 could not be verified without executing code.

Still open from earlier audits:

| Finding | Source | Tracking |
|---|---|---|
| Composio connectivity unusable; "configured" and "usable" are reported as one state | Sep 9 audit R2 | Issue #270, reopened, no PR |
| macOS updater feed incomplete; shipped build identities do not reconcile | Sep 9 audit R8 | Issue #285, reopened, no PR.  The desktop updater's hourly 404 loop (UI4) is the visible symptom |
| Duplicate and stale board effort rows | Sep 9 audit R9 | Issue #286 |
| Live Activities stale while the app is suspended | Sep 9 audit BF-IOS-010 | Issue #294 (P3); README still advertises "unread Live Activities" (IO26) |
| MiniMax chip-path hardening (transient 401 paging PagerDuty) | Sep 20 MiniMax inspection | Deferred as "next wave"; no issue number |
| Historical credential-scanning alerts | Issue #390 (P0) | The iOS build-output half looks stale (`ios/.gitignore` already excludes `build/`); the alert half is unverified from this seat |

Fixed on Sep 24 while this audit ran, after the audit commit: bounded API transcript replay (#540 via PR #543), Antigravity cache-read tokens in telemetry (#542 via PR #544), screen capture only while watched (#545 via PR #550), and the Windows config-lock race test (#546 via PR #547).  Issues #542, #545, and #546 still show open and should be closed.

Status shifts worth knowing: the default skin now returns `system` (`src/lib/skins.ts:99-101`) where the Sep 1 and Sep 2 documents recorded `studio`; the always-on harness crash-loop root cause (parameter-property syntax under `--experimental-strip-types`) is fixed in source at `server/resource-triggers.ts:347`; the composio-broker registration mode is `closed` in `wrangler.jsonc:11`, though deployed Worker state was not probed.

Could not verify without executing code: group `avatarCrop` on PATCH, the default Composio broker URL, full-auto ACP bots starting local-computer turns, DSH model pick and MCP beyond the auth-gate fix, six Sep 2 renderer race fixes attributed to PR #95, ACP `--mcp` argv handling, Grok Agent `HOME` handling, sqlite commit ordering, ACP cancel telemetry, and steer-queue restart durability.

## Repository And Worktree Hygiene

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| RH1 | P1 | 24 BotFleet worktrees exist on this Mac, holding about 22.5 GB in ten `node_modules` directories (2.0 to 2.2 GB each) plus 311 MB of shared `.git` and about 1.4 GB of working trees, roughly 24 GB on a disk with 12 GB free.  At least one (`~/apps/botfleet-mm-usage-engines`, 2.2 GB) is already merged (PR #528); `mm-apn-transport` and `mm-bundle-rename` look squash-merged too; `~/.cursor/worktrees/.../designer-ui-confirms` is seven days idle with zero commits ahead, 71 behind, and 23 dirty files; `fixer-claude-stdin` is 60 commits behind; `Code/BotFleet-wt-pr529` sits on `main` with no purpose; two lanes carry the same feature under two seat prefixes (`designer/engine-picker-scroll-codex-gpt6` and `fixer/engine-picker-scroll-codex-gpt6`). | `git -C /Users/jay/Code/BotFleet worktree list`; `du -sh` per lane | New.  Fix: prune merged lanes, and have the disk janitor's idle-worktree rule cover `~/apps/botfleet-*` node_modules on merged branches |
| RH2 | P2 | 336 remote branches remain even though the repository setting `delete_branch_on_merge` is on (verified Sep 24; both audit branches were deleted on merge), so the backlog is branches merged before the setting or pushed by seats and never opened as PRs.  The five oldest "unmerged by ancestry" branches were all squash-merged on Aug 31 and Sep 1.  GitHub reports 434 merged, 24 closed, 8 open PRs. | `git branch -r | wc -l`; `gh api repos/... delete_branch_on_merge`; `gh pr list --head` spot checks | New.  Fix: prune once (delete remote branches whose PR is merged or closed), and ask seats to delete a lane branch when they abandon it |
| RH3 | P2 | The integration tree `/Users/jay/Code/BotFleet` is on `antigravity/efficiency-power-preserve` (1 ahead, 3 behind `origin/main`) with seven untracked scratch files (`test-auto-verdict.ts`, `test-auto.cjs`, `test-regex.js`, `test-verdict.cjs`, `test-verdict.js`, `scripts/__pycache__/`, `docs/dsh-voice-mode-scoping.md`), the exact pattern issue #320 and PR #340 eliminated.  That tree is supposed to track `main` read-only. | `git status` in the integration tree | Regression of #320 |
| RH4 | P3 | `.tmp-pr-body.md` (6.3 KB) is tracked on `origin/main`, committed in the PR #528 merge. | `git log a7d6a4f4` | New.  Delete and add to `.gitignore` |
| RH5 | P3 | `docs/EFFORT-LOG.md` (501 lines) lags the live board (532 lines) by the newest entries, and the live board's first line is a stray Slack-style message rather than a row. | `diff` of the two files | Mirrored in this PR; the stray line belongs to the seat that wrote it |
| RH6 | P3 | README still cites tracking issue #345 as open; it closed with PR #402. | `README.md` Linux paragraph | New; one-line fix |
| RH7 | P3 | The always-on checkout `~/apps/botfleet-server` is clean but seven commits behind `origin/main`; historically that staleness was the crash-loop root cause. | `git -C ~/apps/botfleet-server status` | Expected between `ubf` runs; watch it |

Test suite shape: 315 `*.test.ts` files repo-wide (server 191, renderer 104, companion 15) plus 43 Electron node tests and the Swift `CompanionCore` suite.  No `.only`, no unconditional `.skip`; 27 files use platform-conditional `skipIf`.  Vitest runs with `fileParallelism: false` because fake CLIs and a real harness server are spawned, with a 20 s test timeout and no coverage block.  CI observed durations of 3 to 17 minutes are consistent with that serial run on three operating systems.

## What To Fix First

Ranked by damage per unit of effort across every area.  Items marked "landed" merged on Sep 24 after the audit commit.

1. **Stop the harness paying for its own logging (HS10).**  Cap the secret-redaction input and move the event tee to an async append.  Every other stall in this report queues behind that synchronous path.
2. **Make restarts cheap (HS18, HS19, HS20).**  Clear or mark `inflightThreadId` on graceful shutdown, stagger and cap boot recovery, and open the port before boot work so health answers.  With 29 boots in two days this is the largest avoidable token spend.
3. **Stop the pager storm from the phone (IO10).**  One line in `SentryTelemetry.swift` to ignore gateway 5xx from the paired host.
4. **Repair push end to end (IO1, IO1b, IO2, IO3, IO4, IO5).**  Dedupe transport-failure logs, count breaker failures per device and only for the transport family, persist the key-fault latch, stop dropping queued approvals when the circuit is open, and decode the health fields on the phone so "Closed-app notifications: On" stops lying.  Owner action in parallel: the APNs signing key is being refused; verify or replace the `.p8` key, or pushes stay off.
5. **Give the packaged app working Sentry (OP1).**  Externalize `@sentry/node` from the server bundle or apply the `yaml` plugin treatment.
6. **Reclaim disk and bound it (HS1, HS2, HS3, HS9).**  Orphan and age sweeps for `native/`, `events/`, and `workspaces/`, plus prune and `VACUUM` for `messages.db`.  About 3 GB today, and the growth is unbounded.
7. **Coalesce whole-file JSON writes (HS4, HS5, HS6).**  `routines.json` through the atomic writer with a debounce and no indent; `webhooks.json` and `bots.json` debounced instead of rewritten per event.
8. **Bound harness memory (HS12, HS16, HS17).**  LRU-evict `Store.threads`, page `messagePage` in SQL, and honor SSE backpressure.
9. **Retry transient failures on every engine (DR2) and keep Claude sessions warm under a Chief of Staff (DR1).**
10. **Stop the idle renderer burn (UI1) and split the bundle (UI2, UI3).**
11. **Fix telemetry delivery (OP2, HS8, HS23) and the quota pollers (OP3, HS13, HS14).**  Treat 409 as terminal, persist the outbox once per loop, back off and dedupe the Antigravity poll, gate it on a configured engine, and drop the Grok timer.
12. **Harden the update path before the bundle rename (OP4, OP5, UI4).**  Retry and cache the cloudflared download, pass `--current`, refresh the host wrapper from tracked HEAD before PR #524 lands, and cap the desktop updater's hourly retries.
13. **Decouple the companion sidecar from Electron (IO21, IO22).**  Ship the interim distinguishable-status response first so the phone can back off, then move the guardian and origin socket under launchd; fix the Worker's `botfleet.com` host suffix.
14. **Cut the phone's redundant work (IO7, IO12, IO13, IO18, IO19).**  Skip the full hydrate on resumed streams, merge pages instead of wiping them, publish streaming deltas separately, and memoize the roster derivations.
15. **Trim CI and the working set (OP8, RH1, RH2, RH3, RH4).**  Per-area path filters, prune merged worktrees (about 24 GB), prune the merged remote branches once, clean the integration tree, drop `.tmp-pr-body.md`.

## Problems With No Identified Fix Yet

- **Host pressure (Live Host State).**  The Mac is paging at 95.8% swap with 12 GB free and a load average near 200.  BotFleet contributes about 1.3 GB RSS and its worktrees consume about 24 GB, but most of the pressure is other agent harnesses and WebKit processes.  The resource watch's cooldowns (OP6) keep the Housekeeper asleep through it; the right escalation design is open.
- **Launchd retry ceiling (OP10).**  The harness wrapper retries every 5 to 7 s forever when `node_modules` is missing.  A retry cap needs a matching "needs a human" signal that nothing consumes today.
- **Keep-alive sessions for ACP engines and Codex (DR3).**  Whether each CLI can hold a stdio session across turns is unknown; the fix needs per-engine verification.
- **Antigravity global mutex (DR4).**  Releasing the lease after the child reads its MCP config depends on whether `agy` re-reads the file mid-turn, which this repo cannot answer.
- **Double dispatch on resume (HS20).**  Inferred, not executed; needs a targeted test before any change.
- **The refused APNs key (IO2).**  Code can only stop resending; only the owner can verify or rotate the key.
- **Branch and worktree policy (RH1, RH2).**  Pruning is mechanical; the policy that stops the sprawl recurring (who deletes a lane after squash-merge) is a fleet rule, not a code change.

## Method And Limits

Everything cited was read at `beb2e689`; line numbers drift as `server/index.ts` grows, so treat symbol names as the stable reference.  No worker executed BotFleet code, ran tests, or built anything; the harness-core worker ran a standalone `JSON.stringify` timing on this Mac.  Live host numbers came from `top`, `pgrep`, `lsof`, `du`, `sqlite3`, and the harness, updater, and resource-watch logs; no configuration, secret, or plist environment value was read.  Not covered: the `agents`-account iMessage listener (unreadable from this seat), `electron/managed-companion-tunnel.mjs` restart and backoff correctness, `release.yml` signing and notarization, Worker per-request costs, the botfleet.app site workflow, and the desktop packaging for Windows and Linux.  Worker reports are in this session's transcript; this document keeps only what was verified.
