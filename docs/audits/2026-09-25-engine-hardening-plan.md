# Engine Hardening Plan (2026-09-25)

Produced by the CLAUDE seat's six-dimension engine audit (157 agents, three-lens adversarial verification, 46 verified findings, 4 refuted).  Findings table: `2026-09-25-engine-audit-findings.md`.  Lane: `claude/engine-hardening`, one PR per unit on `claude/engine-<slug>`.


Synthesized at HEAD 08b7da6a (ece4e702 → c94b288e → #640 → #636 → #638 landed during the audit).  Every line number below was re-pinned at 08b7da6a with `grep -n`/`sed -n` in this session.  Test runner is vitest (`scripts/test-floor.mjs` wraps `vitest run`), so per-file verification is `pnpm vitest run <file>` plus `pnpm typecheck`; the Mac is at load average 280, so run only the named files, never the full chain, until CI takes it.

## Dropped as already in flight

| Finding | Why dropped |
|---|---|
| 18-minute ACP wall clock | #639 merged (core.ts:305/310 now 18 min max + 180 s idle) |
| MiniMax idle stall | #629 merged (readChunkOrStall) |
| bots/routines/webhooks.json write storms | #636 merged |
| Claude/HTTP-lane system-prompt halves | #635 open; the CLI/ACP half is a **deferred** follow-up below, not dropped |
| stale grok-3-mini in generateText | AG lane ag/grok-generatetext-model |
| Packaged Sentry SDK `require('util')` (91d45243) | fixed by #580 (scripts/bundle-server.mjs createRequire banner); `test:packaged-server` already runs in per-PR CI (package.json:36).  Close the board row with "Landed in #580". |
| DSH mounts BotFleet MCP | GROK lane 3bfa4c2c; Unit 8 marks DSH `mcp.verified:false` until it lands |
| Delegation to busy peer (8613c983), computer parity (7a3d30af), HTTP-lane capability expansion (da75e2da), Composio (624b1a4f) | separate rows, not touched |
| DSH/MiniMax model-option array | fixed by #518 (dshProviderForModel); only the reasoning-effort half survives, see Deferred |

## Dedupe map

- **Stop pages Sentry** = findings "User Stop on Claude/Codex/Antigravity settles exit_before_result" + "BOTFLEET-R claude exited 143" + the SIGTERM half of "Antigravity misclassifies quiesce kill" → Units 3 and 4.
- **classifyError** = "unexpected status → invalid_request" + "CLI exits check transient before terminal" → Unit 2.
- **Antigravity** = "relaunches its own timeout" + "retry has no deadline guard" + "11-minute watchdog unconfigurable" (ede5d0a7) → Unit 3.
- **Capability gate** = no task gate + fallback ignores capabilities + flags mix mount/approval + peer routing blind + no degradation telemetry + no circuit breaker + spawn_error dispatcher refusal + `worksInWorkspace` duplicate (5fc628cb, 3997db1b, 4a042037) → Unit 8.
- **Antigravity always-proceed policy** (two findings) → the runtime.error allowlist part lands in Unit 1; the "detect once" part is Unit 8's doomed policy.

---

## Unit 1 — Sentry secret scrub and honest failure classification  (P0 + P1, effort S, build first)

**Board rows:** new row for the webhook-secret leak (file as P0); 64324c2c (partial: the classification side); BOTFLEET-13, BOTFLEET-M grouping, BOTFLEET-5, BOTFLEET-7.
**Files:** `server/sentry.ts`, `server/sentry-ai.ts`, `server/webhook-ingress.ts` (comment only).  Disjoint from every other unit.

Changes:
1. `server/sentry.ts:326-345` `sdk.init({...})` has no `beforeSend`/`beforeSendTransaction` (grep confirms none in the file).  Add both.  Rewrite `event.transaction`, `event.request?.url`, `event.tags?.url`, `event.tags?.transaction`, every span `description`/`data['http.url']`/`data['url.full']`, and `event.culprit` with `/\/hooks\/(wh_[A-Za-z0-9_-]+)\/[^/?\s]+/g → '/hooks/$1/:secret'`, then a second pass `/\bwhsec_[A-Za-z0-9_-]+/g → 'whsec_[redacted]'`.  Also pass `sdk.httpIntegration({ ignoreIncomingRequests: (url) => url.startsWith('/hooks/') })` so `/hooks/*` never becomes a transaction at all.  Fix the comment at `server/webhook-ingress.ts:171-174`, which is only true for the explicit captureException tags.  Route regex for reference: `webhook-ingress.ts:127`.
2. `server/sentry-ai.ts`: extend `SentryCaptureContext` (:57) with `fingerprint?: string[]`, pass it through the live sink at :215-216, and set it at both capture sites: `:557` → `['bot-runtime-error', provider, classifyMessage(event.message)]`, `:594` → `['bot-turn-failure', provider, stopReason]`.  Never fingerprint on the raw free-text message.
3. `sentry-ai.ts:534-548`: remember setup runtime.errors per turn key (`setupErrorTurns: Map<key, message>`, mirror `initTimeoutTurns` at :90/:548/:568).  At turn.completed (:565-597), when the key has a saved setup message, `captureMessage` at warning level with the saved text and fingerprint `['bot-setup', provider]` instead of the bare `bot turn failed: spawn_error`.  Add `botfleet.stop_reason` and `botfleet.setup` to `failureTags` (:356-371).
4. `sentry-ai.ts:333` `EXPECTED_TURN_STOPS`: the `request_timeout` entry never matches because `chat-completions/loop.ts:88` maps it to `"timeout"`.  Replace with a per-turn flag set when the "the model did not answer within" breadcrumb fires (:540), and treat stopReason `"timeout"` as expected only for that key.  Do not add `"timeout"` to the set unconditionally (wall_clock also maps to it).
5. Add `host_control_policy` to `EXPECTED_TURN_STOPS` and the antigravity refusal text (`antigravity.ts:117` `antigravityHostPolicyRefusal`) to `isExpectedNonCrash` (:534), as a warning breadcrumb.  It is a deliberate, fail-closed refusal (antigravity.ts:1026-1037), not a crash.
6. Add `"interrupted"`-shaped runtime.errors from the drivers (Units 3/4 stop emitting them, but until they merge) are not needed; instead rely on Units 3/4.  Keep `"interrupted"` in the set (already there).

**Tests:** `server/sentry.test.ts` — feed an event with `transaction: 'POST /hooks/wh_abc/whsec_xyz'`, `request.url`, a span description and a bare `whsec_` in a breadcrumb through the hooks; assert no `whsec_` survives and the endpoint id is kept.  `server/sentry-ai.test.ts` — (a) spawn_error after a `setup:true` runtime.error captures a warning message containing "isn't installed", not "bot turn failed: spawn_error"; (b) two providers with the same throw site get different fingerprints; (c) a "the model did not answer within" runtime.error followed by `stopReason: "timeout"` does not captureException; (d) `host_control_policy` stop does not page.
**Verify:** `pnpm typecheck && pnpm vitest run server/sentry.test.ts server/sentry-ai.test.ts`.
**Operational (owner, not code):** rotate the three exposed webhook endpoints (wh_WeP8…, wh_myr8…, wh_vvtR…) and delete the affected Sentry events; mention revocation in the PR body.
**Risk:** low.  Fingerprint change will "reset" issue history in Sentry (existing issues stop receiving events, new ones open).  Say so in the PR.

---

## Unit 2 — One classifier order for every input shape  (P1, effort S)

**Board rows:** none existing; file one ("classifyError verdict depends on input shape").
**Files:** `server/drivers/retry.ts`, `server/drivers/retry.test.ts`.  Disjoint.

Changes at `retry.ts`:
- `:111` remove `unexpected status` from the `invalid_request` arm; add `unexpected status` to `HTTP_STATUS_CONTEXT` (:58) so `classifyByStatusCode` decides on the digits (503/429 → transient, 400/401 → terminal).
- `:115` narrow the `interrupted` arm to the drivers' own phrases: `/\b(?:interrupted by user|cancelled by user)\b/i`, so "stream interrupted: connection lost" is transient.
- `:173-191` unify the order for exit reports and Error/text: **quota and auth terminal arms first, then transient, then remaining terminal, then status codes**.  This keeps `retry.test.ts:83-89` ("429 too many requests" as CliExit → transient) passing, since no quota noun matches that string, while `{exitCode:1, stderr:"Rate limit reached for this month"}` becomes quota (terminal) and `"RESOURCE_EXHAUSTED … capacity"` becomes quota.
- Keep `code < 0 → interrupted` (:175).

**Tests:** extend `retry.test.ts` with a table: for each of ~12 strings (unexpected status 503, unexpected status 429, unexpected status 401, rate limit reached for this month, RESOURCE_EXHAUSTED capacity, overloaded, stream interrupted, interrupted by user, ECONNRESET, timeout waiting for response, Invalid params) run all three shapes (`new Error(s)`, `{text:s}`, `{exitCode:1, stderr:s}`) and assert identical `{transient, reason}`.
**Verify:** `pnpm typecheck && pnpm vitest run server/drivers/retry.test.ts server/drivers/codex.test.ts server/drivers/claude.test.ts`.
**Risk:** the fake Codex server (`server/testing/fake-codex-app-server.ts:131,163`) uses "unexpected status 401" and must still classify as auth: the auth arm runs first, so it does.  Callers: claude.ts:1013, codex.ts:699, antigravity.ts:919/1191, acp/core.ts:1132.

---

## Unit 3 — Antigravity: idle timer, no relaunch into a hang, Stop is not a crash  (P1, effort M)

**Board rows:** ede5d0a7 (BOTFLEET-6), BOTFLEET-10 half of the SIGTERM finding.
**Files:** `server/drivers/antigravity.ts`, `server/drivers/antigravity.test.ts`.  Disjoint.

Changes:
1. Replace the wall-clock `watchdog = setTimeout(..., 11 * 60_000)` at `:1223-1235` with an idle timer re-armed on every parsed stdout line (the `data` handler around :1150).  Two windows: `idleMs` ≈ 180 s while no `step_update` tool is ACTIVE, `toolIdleMs` ≈ 8 min while one is; plus a hard `maxMs` from `decodeConfig` (`promptTimeoutMs`, same validation as `acp/core.ts:389-403`, default 11 min).  Raise `--print-timeout` (`:806`, `"10m"`) to match `maxMs` so agy does not kill a still-streaming turn before we do.  Emit `runtime.notice`/activity at 80 % of whichever window is live (the pre-cliff chip ede5d0a7 asks for).  Settle idle trips with `stopReason: "prompt_stall"` so `index.ts:2566` clears the resume cursor as it does for ACP.
2. `maybeRetry` (`:915-925`): return false when `classifyError(failure).reason === "timeout"` or when elapsed ≥ `maxMs`.  This stops the ERROR-result path (`:1089-1093`, agy's own "timeout waiting for response", 23 hits in errors.log) and the exit path (`:1191`) from relaunching into the same hang (up to ~30 min today).
3. Stop convention: the interrupt wrapper at `:1213-1219` sets `retry.cancelled` and kills but never settles.  In `finishOnChildGone` (`:1178-1194`), when `retry.cancelled` is set, `settle(false, "interrupted")` with **no** runtime.error.  This removes BOTFLEET-10 ("agy was killed by SIGKILL before result") for user Stop and forced quiesce.
4. Leave `localComputerMcp: true` (`:1308`) alone here; Unit 8 exposes `approvals: 'auto-deny'` in the profile instead.

**Tests:** extend `antigravity.test.ts` with scaled timers (the file already has `retryScale`): (a) agy emits `tool step_update ACTIVE` then goes silent 200 s → not killed; silent 9 min → `prompt_stall`; (b) no output for 200 s with no tool → `prompt_stall`, no `turn.retrying`; (c) an ERROR result "timeout waiting for response" with no output → exactly one `turn.completed`, no relaunch; (d) `interruptTurn` mid-turn → `{ok:false, stopReason:"interrupted"}` and zero `runtime.error` events.
**Verify:** `pnpm typecheck && pnpm vitest run server/drivers/antigravity.test.ts server/sentry-ai.test.ts`.
**Risk:** agy's MCP lease (`:233-236`) is released and re-queued between attempts, so removing relaunch shortens lease hold time; no other consumer depends on the 11-minute constant (grep confirms only the two comments at :213/:234).

---

## Unit 4 — Claude and Codex: Stop is not a crash, retained-session closure, is_error reason, hard kill  (P1, effort M)

**Board rows:** 64324c2c (claude subtype/is_error side), BOTFLEET-R, BOTFLEET-9, 4a3ee87b (strict-mcp probe).
**Files:** `server/drivers/claude.ts`, `server/drivers/codex.ts`, `server/procs.ts`, their tests, `server/kill-tree.test.ts`.  Disjoint from Units 3/5/6.

Changes:
1. **claude.ts close handler** (`:1008-1093`): when `retry.cancelled` is set, skip the runtime.error and `settle(false, "interrupted")`.  Update `claude.test.ts:626-633` to expect `stopReason: "interrupted"`.
2. **claude.ts retained-session closure** (`:727-745`, stop at `:731`, relaunch at `:1068`): the spawn-time close handler closes over turn 1's `turn`, `turnId`, `retry`.  Store `{ turnId, input: SendTurnInput, retry }` on `session.turn`; have the close handler read `session.turn.input`/`.retry`; make the retained-path stop at `:731` set `session.turn.retry.cancelled = true` before `killCliTree`; reset `session.stderr` (`:997-999`) at each turn start so old stderr cannot make a later crash look transient.
3. **claude.ts result case** (`:960-976`): `const ok = o.is_error !== true && (o.subtype == null || o.subtype === "success")`.  On `!ok`, stopReason = `terminal_reason ?? (subtype !== "success" ? subtype : null) ?? (api_error_status ? \`api_error_${status}\` : null) ?? "error"`, never falling back to a stale `stop_reason`.  Emit `runtime.error` with `redactSecretsInText(String(o.result ?? '')).slice(0,500)` plus the status so errors.log (`index.ts:2452-2466`), Sentry and quota parsing see it.  Map 429 to `error:rate_limited` so `providerErrorCodeFromStopReason` (model-fallback.ts) recognises it and records a cooldown.
4. **claude.ts strict-mcp probe** (`:1135-1152`, `timeout: 3000` at `:1143`): scale the probe timeout with host load like `acp/init-deadline.ts` (≥ 8000 ms base, same as the `--version` probe), and do not cache a timed-out probe as "unsupported" (only a real `--help` output without the flag is cached).  Resolves board 4a3ee87b; PR #611 was rejected for fixing the wrong cause.
5. **codex.ts close handler** (`:569-578`): when `stopRequested` (`:308`) is set, `settle(false, "interrupted")` with no runtime.error (the pattern already exists at `:725`).  Also classify `turn/completed status: failed` (`:511-514`) through `classifyError` so quota text records a cooldown instead of becoming the raw stopReason.
6. **procs.ts**: add `killCliTreeHard(child, graceMs = 2000)` that signals `-pid` with SIGTERM even when `child.exitCode !== null` (drop the early return at `:116` for the group kill, catch ESRCH), then SIGKILL `-pid` after `graceMs`.  Use it from claude.ts closeSession (:505-506, remove the `exitCode === null` guard) and stop (:1105-1109), codex.ts stop/settle (:307-310/:320).  Units 3 and 6 can adopt it later; do not touch them here.

**Tests:** `claude.test.ts` — (a) interrupt → `interrupted`, no runtime.error; (b) two turns on one retained process, second exits 1 with "overloaded" on stderr → relaunch carries turn 2's text and turnId, turn 2 gets exactly one `turn.completed`; (c) result `{is_error:true, subtype:"success", terminal_reason:"api_error", api_error_status:429, stop_reason:"stop_sequence"}` (the BOTFLEET-K shape in `fake-claude-cli.ts:224-233`) → stopReason `error:rate_limited` and a runtime.error carrying the result text; (d) strict-mcp probe that times out is not cached and the turn is not refused.  `codex.test.ts` — stop → `interrupted`, no runtime.error; `turn/completed failed` with quota text → cooldown-shaped stopReason.  `kill-tree.test.ts` — leader exited, grandchild alive → SIGTERM then SIGKILL reach the group.
**Verify:** `pnpm typecheck && pnpm vitest run server/drivers/claude.test.ts server/drivers/codex.test.ts server/kill-tree.test.ts server/sentry-ai.test.ts`.
**Risk:** `index.ts:1777-1779` and `stoppedTurns` already tolerate either settle reason for fallback; check `resume-recovery.test.ts` still passes since it inspects stop reasons after restart.

---

## Unit 5 — pi driver: settle on model refusal, drain stderr, fail a lost session  (P1, effort S)

**Board rows:** none; file one ("pi: three turn-lifecycle defects").
**Files:** `server/drivers/pi.ts`, `server/drivers/pi.test.ts`.  Disjoint.

Changes:
1. Wrap everything after `active.set` (`:625`) and `turn.started` (`:753`) — handshake, `set_model`, thinking level, prompt send — in try/catch.  On throw (`:795` "pi refused the model", or a 20 s `awaitResponse` timeout at `:556`), emit `runtime.error` and `settle(false, "model_refused")`; `settle` already kills the child, removes the 0600 `mcpTempDir` and deletes the `active` entry.  Return `{ turnId }` instead of rethrowing (the `index.ts:3766-3772` catch never calls `interruptTurn`, so a throw wedges the thread with "a turn is already running", `:482`).
2. Add a bounded stderr tail after the spawn at `:528` (`stdio` pipes stderr, file has zero `stderr` reads).  In the close handler (`:747-751`) emit `runtime.error` `pi exited ${code} before agent_end: ${stderrExcerpt}` and `settle(false, "exit_before_result")`.  Drain stderr on the probe spawns at `:313` and `:826` too (cleanup).
3. `:762-777` silent `catch {}` after `switch_session`: when `sessionPath` was set and the switch failed, do not send the prompt on an empty `--no-session` context.  Emit `runtime.error` "The saved pi session could not be resumed" and `settle(false, "resume_failed")`, which `index.ts:2566` already treats as clearing the resume cursor.  Scale the `awaitResponse` timeout for `switch_session` with host load (`acp/init-deadline.ts` helper).
4. `:718`: map pi-ai stop reason `"length"` to `"max_tokens"` instead of `"end_turn"`.

**Tests:** extend `pi.test.ts` with the fake pi RPC: (a) `set_model` responds `success:false` → one `turn.completed {ok:false, stopReason:"model_refused"}`, child killed, temp dir gone, a second turn on the thread starts; (b) child writes 100 KB to stderr then exits 1 → turn settles `exit_before_result` with an excerpt, no 20-minute hang; (c) `switch_session` fails → `resume_failed`, no prompt sent; (d) `agent_end` with `stopReason:"length"` → `max_tokens`.
**Verify:** `pnpm typecheck && pnpm vitest run server/drivers/pi.test.ts`.
**Risk:** low; no other file reads pi's stop reasons by string except sentry-ai's expected set (Unit 1 adds nothing for `model_refused`, which should page — it is a real failure).

---

## Unit 6 — ACP core: tool-aware idle, session/new diagnostics, truncation, usage dimensions  (P1/P2, effort M)

**Board rows:** 2c6611a1 (issue #559), BOTFLEET-M, gap left by #639.
**Files:** `server/drivers/acp/core.ts`, `server/drivers/acp/acp.test.ts`, `server/drivers/acp/stop-reason.test.ts`.  Disjoint from Units 3/4/5; Unit 7's `native.ts` change is a separate file.

Changes:
1. **Tool-aware idle.**  `armIdle` (`:702-716`) re-arms only when `asks.size`; re-arm points are `:1094` (inbound lines) and `:673` (our replies).  Keep `openTools: Set<string>` in `handleNotification`: add on `tool_call` (`:998`) with status pending/in_progress, delete on `tool_call_update` (`:1019`) completed/failed.  In `armIdle`, when `openTools.size > 0`, use `promptToolIdleMs` (new config, default 10 min, capped by `DEFAULT_PROMPT_MAX_MS` :305) instead of `DEFAULT_PROMPT_IDLE_MS` (:310).  Clear `openTools` on settle.
2. **session/new** (`:300` 120 s, `:1231`): give `AcpRpcTimeoutError` a detail string like initialize's (`:1182-1183` `describeInitDeadline`): elapsed, `mcpServers.length` and names, last 300 bytes of stderr (`:1117-1120`) through `redactSecretsInText`.  Cap relaunch after a session/new timeout at one, by widening `initRelaunchSpent` (`:1398`) to `(initTimedOut || sessionNewTimedOut)`.  Add `botfleet.acp.method` and `botfleet.mcp_server_count` to the runtime.error at `:1404-1409`.
3. **Truncation** (`:1341`): `settle(true, "max_tokens")` when `reason === "max_tokens"`; keep `end_turn` → `null` behaviour unchanged.
4. **Usage** (`:1329-1341`, `:1047-1066`): read `cachedReadTokens`, `cachedWriteTokens`, `thoughtTokens`, `totalTokens` from `result.usage`; emit `cachedInput: cachedReadTokens` on turn.completed (claude.ts:969-974 shape).  Do **not** add cache tokens into `input` until each engine confirms whether `inputTokens` already includes them (add a per-support flag `usageInputIncludesCache?: boolean`, default unknown → do not sum).  From `usage_update`, keep `u.cost` when `currency === "USD"`, store the cumulative amount on the session, and pass the per-turn delta as `cost` with `billingMode: "estimated"`; record `u.size` as `gen_ai.request.context_window` via the existing telemetry attribute path.  The four `cost: null` settles (`:550, :801, :869, :892`) read from the session field instead.

**Tests:** `acp.test.ts` with the fake ACP CLI and scaled timers: (a) `tool_call in_progress` then 200 s silence → no `prompt_stall`; silence past `promptToolIdleMs` → `prompt_stall`; (b) session/new never answers → error message names the server count and stderr tail, and exactly one relaunch; (c) `stopReason:"max_tokens"` → `turn.completed {ok:true, stopReason:"max_tokens"}`; (d) `usage_update` with `cost:{amount:0.12,currency:"USD"}` twice → turn.completed cost 0.12 then delta; `stop-reason.test.ts` for the max_tokens mapping.
**Verify:** `pnpm typecheck && pnpm vitest run server/drivers/acp/acp.test.ts server/drivers/acp/stop-reason.test.ts server/drivers/acp/dsh.test.ts server/rolling-spend.test.ts`.
**Risk:** `index.ts:2685` gates `rollingSpendTracker.recordTurn` on `cost > 0`; ACP turns start counting.  UsageSection will show ACP spend for the first time; say so in the PR.  DSH shape in Harness is untouched (only the generic runtime changes).

---

## Unit 7 — Hot-path timers and main-thread stalls  (P1/P2/P3, effort S+M)

**Board rows:** bf77b434 (HTTP lane half), da75e2da (grok timer), new row for the native tee.
**Files:** `server/drivers/grok.ts`, `server/drivers/chat-completions/loop.ts`, `server/drivers/openai-compat.ts`, `server/drivers/minimax.ts` (call site only), `server/drivers/native.ts`, `server/model-fallback.ts:458-472`.  Disjoint from Units 1-6 except `model-fallback.ts`, which Unit 8b also edits at `:409-435` (different function; rebase).

Changes:
1. `grok.ts:90-92`: replace `AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])` with `opts.signal ?? AbortSignal.timeout(180_000)`, the `minimax.ts:421` / `openai-compat.ts:200` pattern.  The inner 120 s timer races the loop's 180 s round deadline (`loop.ts:131`), so a slow reasoning round is retried into 60 s and then fails as `provider_error`, which pages.
2. `loop.ts:604-607`: split the budget into `requestTimeoutMs` (hard ceiling, raise default to 600 s) and new `requestIdleMs` (default 120 s) reset on every `onPublished` (`:637`) and every raw chunk via a new `onChunk` callback on `runRound` opts (`:206`), called from the SSE reader loops in grok/minimax/openai-compat.  `openai-compat.ts:30/503` keeps its 120 s as the idle value, not the ceiling.  Leave MiniMax's `readChunkOrStall` (#629) in place this PR; retiring it is a follow-up once the shared guard has run in production.
3. `native.ts:21-23`: switch `redactSecrets` → `redactSecretsForLog` (shared/redact.ts:1117, capped) and `appendBounded` → `appendBoundedAsync` through the per-file `append-queue`, as `server/harness/bus.ts:50` already does.  In `core.ts:1089` (one-line touch, coordinate with Unit 6) skip the tee for `session/update` lines that arrive before `state.promptSent` or carry `_meta.isReplay`.
4. `model-fallback.ts:458-472`: hoist `new Intl.DateTimeFormat(...)` out of the 2,160-iteration loop.

**Tests:** `grok.test.ts` — a round that streams for 150 s completes (fake timers) and a 200 s stall ends as `request_timeout`, not `provider_error`.  `openai-compat.test.ts` — a stream still delivering bytes at 130 s is not aborted; 125 s of silence is.  `native.test.ts` — a 5 MB msg is capped and the append does not block (assert the writer queue is used).  `model-fallback.test.ts` — `computeNextOccurrence` still returns the same instant for a zoned reset (behaviour pin).
**Verify:** `pnpm typecheck && pnpm vitest run server/drivers/grok.test.ts server/drivers/openai-compat.test.ts server/drivers/minimax.test.ts server/drivers/native.test.ts server/model-fallback.test.ts server/http-lane-e2e.test.ts`.
**Risk:** the loop's replay-safety rule (never retry a round that published) is unchanged; only the deadline shape changes.  The native tee async change must preserve per-thread ordering (use the append queue, not bare `appendFile`).

---

## Unit 8 — Capability gate, doomed-effort policy, fallback filter, routine receipts, circuit breaker  (P1, effort L, split into 8a + 8b)

**Board rows:** 5fc628cb, 3997db1b, 4a042037, plus the P3 `worksInWorkspace` duplicate.  Build after Units 1-7 or in a parallel worktree; it touches `index.ts` regions no other unit edits.

### 8a — profile module, gate, endpoints, metric

**Files:** new `server/capability-profile.ts` + `.test.ts`, `server/contracts.ts`, `server/harness/registry.ts`, `server/computer-grants.ts`, `server/index.ts` (startTurn :3078, runGroupMemberTurn ~:4778, RoutineManager `canStart` :3807, `/api/instances` neighbour ~:10201, `worksInWorkspace` :3442/:5013), `server/telemetry.ts`, `src/components/EnginesSettings.tsx` (badges).

**Schema** (`server/capability-profile.ts`, dependency-free like `computer-capability.ts` so the client can import it):

```ts
export type TaskClass = 'chat'|'coding'|'shell'|'desktop_gui'|'vm'|'cloud'|'images'|'connected_apps'|'peer_comms';
export type Approvals = 'broker'|'auto-deny'|'none';
export interface CapabilityProfile {
  engine: DriverKind; model: string;
  transport: ComputerTransport | null;        // from computer-capability.ts
  reach: ComputerReach;                        // computerReach(...)
  approvals: Approvals;                        // antigravity → 'auto-deny'
  mcp: { mounted: boolean; verified: boolean };// DSH verified:false until 3bfa4c2c
  images: boolean; steer: boolean; dweb: boolean;
  workspaceTools: boolean;                     // replaces the two worksInWorkspace literals
  shell: 'always'|'with_host_grant'|'never';
  effortLevels: readonly string[];
  setupRequirements: string[]; executionHints: string[];  // 3997db1b
}
export type DoomedVerdict = 'refuse'|'warn';
export const DOOMED_POLICY: Record<DriverKind, Partial<Record<TaskClass, DoomedVerdict>>>;  // seeded from 4a042037
export interface WisdomEntry { engine; best_for: string[]; avoid_for: string[]; setup_required: string[]; anti_pattern: string[]; last_confirmed_by: string; last_confirmed_at: string; confidence: number }
export const WISDOM: WisdomEntry[];
export function profileFor(instance: ProviderInstance, model: string): CapabilityProfile;
export function requiredFor(input: { computers: BotComputers; text: string; routineNeeds?: TaskClass[]; skillCaps?: string[] }): Set<TaskClass>;
export function doomedReason(profile: CapabilityProfile, required: Set<TaskClass>, policy = DOOMED_POLICY): { taskClass: TaskClass; verdict: DoomedVerdict; reason: string } | null;
```

- `profileFor` defaults from `adapter.capabilities` + `computerReach`, then applies an optional `ProviderInstance.profile?(model): Partial<CapabilityProfile>` hook added to `contracts.ts` next to `reviewPermission` (~:584-606).  Antigravity's hook returns `approvals:'auto-deny'` (its `respondToRequest` is `"unavailable"`, antigravity.ts:1316); DSH's returns `mcp.verified:false`; grok HTTP returns `workspaceTools:false, shell:'with_host_grant', images:false`; boxAgent returns `transport:'remoteAgent'`.
- `requiredFor` is deterministic in v1: `desktop_gui`/`vm`/`cloud` from bot.computers grants and `runOn`; `images` from `<attached-image` tags in the text; `connected_apps` from composio/phone grants; a routine's new optional `needs: TaskClass[]` field (RoutineSchedule/ManagedRoutine); `selectBundledSkills` `requiredCapabilities` (already used for phone at index.ts ~3396-3405).  No prompt NLP.
- Seed `DOOMED_POLICY`: `antigravityAgent: { desktop_gui:'warn' }` (degrade is deliberate per computer-grants.ts:631-637, so warn not refuse), `grok: { coding:'refuse' }` when no host grant, `dshAgent: { connected_apps:'warn' }`, every non-image engine `{ images:'refuse' }`, every engine whose `reach.vm` is false `{ vm:'refuse' }` (moves the throw at computer-grants.ts:622 up to the gate).

**Consult points:**
- `startTurn` right after the `if (!instance)` block (~index.ts:3196), **before** `appendMessage` so a refusal writes no transcript row.  `refuse` → throw a 409 `{ code:'incapable', taskClass, missing }`; `warn` → `notice()` chip + metric, continue.
- `runGroupMemberTurn` at the same point.
- `RoutineManager.canStart` (index.ts:3807): consult and receipt `skipped_incapable` instead of dispatching.
- `resolveTurnComputerMounts` (computer-grants.ts:609-705): return `degraded: Array<{kind, reason}>` alongside mounts; callers count `botfleet.dispatcher.capability_degraded`.

**Metric:** `getSentry()?.metrics.count('botfleet.dispatcher.doomed_skipped', 1, { attributes: { engine, model, task_class, reason, lane } })` guarded by `isSentryActive()` (telemetry.ts:463-466 pattern); also `botfleet.dispatcher.capability_degraded`.  Add `requiredCaps`/`mountedCaps` to `TelemetryTurnParams` (telemetry.ts:17).

**Endpoints:** `GET /api/inspect/capabilities` → `{ profiles: profileFor() over registry.instances() × models.options, policy: DOOMED_POLICY }`; `GET /api/inspect/wisdom` → `WISDOM` + per-engine `executionHints`.  Beside `GET /api/instances`.  `executionHints` are appended to the system prompt only when `buildTurnContext`'s `fresh` flag is true (~index.ts:3300), so they ride the first prompt only.

**Badges:** `InstanceInfo` (registry.ts:125-150) gains `profile` and stops dropping `toolLoop`/`qdrantMcp`/`replaysTranscript`; `EnginesSettings.tsx` renders approvals/mcp.verified/images/steer chips from it.

**Cleanup in the same PR:** replace both `worksInWorkspace` literals (index.ts:3442, :5013) with `profile.workspaceTools`.

**Tests:** new `server/capability-profile.test.ts` (profile table per engine; `doomedReason` matrix; `requiredFor` on image tags, grants, routine needs).  `server/index.test.ts` — startTurn on an antigravity bot with an attached image returns 409 and appends no message; an antigravity routine with `needs:['desktop_gui']` and an unattended trigger is receipted `skipped_incapable`.  `server/computer-grants.test.ts` — `degraded` array populated for `unattendedAgy`.  `server/computer-capability.test.ts` unchanged.
**Verify:** `pnpm typecheck && pnpm vitest run server/capability-profile.test.ts server/index.test.ts server/computer-grants.test.ts server/computer-capability.test.ts server/routines.test.ts server/unattended.test.ts`.

### 8b — fallback filter, routine receipt during failover, circuit breaker, peer routing

**Files:** `server/turn-safety.ts:283-364`, `server/model-fallback.ts:409-435`, `server/routines.ts` (failRun :1209-1223, handleRuntimeEvent :1128-1174, enqueueResource, tick), `server/tools/agents.ts:37-78`, `server/index.ts` settle fold (:2131, :2731-2736), `executeAskBotRequest` (~:4381), `executeDelegateBotRequest` (~:4446), `server/delegations.ts:253-297`.

- **Fallback filter:** extend `AutoFallbackCandidate` (turn-safety.ts:295) with `profile`; pass `required` into `eligibleAutoFallbackChain` (:327) and filter; in `selectTurnFallback` (model-fallback.ts:409-435) skip chain entries whose profile fails `required` and advance `nextUsed` past them.  `AUTO_FALLBACK_PRIORITY` (:396) unchanged.
- **Routine receipt:** in the settle fold, decide the fallback before handing a terminal `!ok` to `routines.handleRuntimeEvent` (index.ts:2131).  Add `routines.markFallingOver(threadId, nextSelection)` which keeps the run `running` and bumps `attempts`; only call `failRun` when `selectTurnFallback` returns undefined.  Carry `runOn` on the stored user message and pass `runOn` + `onDispatchError` through the fallback `startTurn` at :2731-2736 (today a cloud routine's retry runs on the local engine in the host workspace).
- **Circuit breaker:** `consecutiveFailures` per `(routineId, engineId, outcomeCode)` in `failRun`, reset on a completed run; after 3 with the same capability/doomed code set `routine.pausedReason='incapable'`, skip in `tick`, `enqueueResource` (index.ts:4284 wires it) and the webhook enqueue, send one notification, count `botfleet.routine.auto_paused`, surface in the Routines UI.
- **Peer routing:** `AgentPeerRow` (tools/agents.ts:37-44) gains `engine`, `computers`, `can: TaskClass[]`; `executeAskBotRequest`/`executeDelegateBotRequest`/`processOne` accept optional `needs` and return `{ error:'incapable', missing }` before the approval card.  Also add the same fields to the Chief of Staff roster (chief-of-staff.ts:65-73).

**Tests:** `turn-safety.test.ts` + `model-fallback.test.ts` — Local-VM bot with claude/antigravity/codex capped never selects minimax; image turn skips grok/minimax.  `routines.test.ts` — a failed run that fails over is not receipted failed, its fallback outcome lands on the same run, `runOn:'cloud'` is preserved; three doomed failures pause the routine and the fourth tick does not dispatch.  `delegations.test.ts` + `peer-approval.test.ts` — `needs:['desktop_gui']` to a grok HTTP peer returns `incapable` before approval.
**Verify:** `pnpm typecheck && pnpm vitest run server/turn-safety.test.ts server/model-fallback.test.ts server/routines.test.ts server/delegations.test.ts server/peer-approval.test.ts server/resource-triggers.test.ts server/sentry-crons.test.ts`.
**Risk:** the settle-fold reorder changes when Sentry cron check-ins fire (`checkInFinish`); `sentry-crons.test.ts` must be updated deliberately.  `board list` shows 5fc628cb/3997db1b claimed by CLAUDE on this lane already; comment the split (8a/8b) on both rows before starting.

---

## Build order and parallelism

Units 1, 2, 3, 4, 5, 6, 7 touch disjoint files (only `core.ts:1089` in Unit 7 and `model-fallback.ts` in 7/8b overlap by file, not by region) and can run in seven worktrees at once.  Land order by damage per effort: **1 → 2 → 3 → 5 → 4 → 6 → 7 → 8a → 8b**.  Unit 8 should start after Units 3-6 merge so its `profile()` hooks are added to stable driver files.

## Deferred, and why

| Item | Why deferred |
|---|---|
| System prompt re-inlined on every resumed turn for Codex/Pi/Antigravity/ACP (`codex.ts:209`, `pi.ts:814`, `antigravity.ts:714`, `core.ts:1315-1319`, every `buildPromptText`) | P0-class waste, but it needs #635's `stable`/`volatile`/`volatileDigest` to land first and touches every driver file Units 3-6 are editing.  Schedule as the first follow-up PR after 8a: inline `turn.system` only when no `resumeCursor`, send the volatile half on digest change; Codex should use `thread/start` instructions and Pi a system-prompt RPC. |
| Replay-window hysteresis (`turn-context.ts:47-80`, `replay-cap.ts:43-130`, plus the 40-message slice at index.ts:3283) and HTTP tool-catalog gating (`tools/registry.ts:1124`, `turn-tools.ts:29-55`) | Overlaps the CODEX lane `codex/token-efficiency-20260924`; check that worktree's diff before claiming.  If stale after a week, fold both into a Unit 9 with the prompt-resend fix. |
| Warm-session cache for ACP/Codex/Pi (`core.ts:616`, `codex.ts:259`, `pi.ts:527`) | L effort, P2; PR #628 already mitigates the acute symptom.  Design note: key on the spawn contract digest, mirror `claude.ts:465-487` Session + SESSION_IDLE_MS. |
| Shared `idle-guard.ts` for Claude/Codex/pi (only the 20-minute harness watchdog at index.ts:1669 covers them) | P2; extract from `core.ts:702` after Unit 6 lands so there is one implementation to lift.  Unit 3 gives Antigravity its own timer now because it is the paging engine. |
| DSH `max` reasoning effort rejected for MiniMax-M3 (62 events/7d) | The catalog `effortLevels` live in Harness (`harness/dsh/acp/driver.ts:89/:145`), which AGENTS.md forbids editing here.  Needs a Harness PR adding per-model `effortLevels: ['none','high']` to the M3 row, then a dependency bump; BotFleet's `configureSession` override (`dsh.ts:95-112`) should then honour the model's list.  Owner approval required for the Harness change. |
| Minimum-CLI-version gate for droid (0.196.0+) and ACP grok (1.0.6+) | P2.  The hook already exists (`core.ts:220` `versionCompatibilityReason`, enforced at :561 and in snapshot); only DSH implements it.  Two small implementations plus having `/api/cli-test` call it.  Cheap, but not engine-hardening's critical path; file as its own row. |
| Antigravity catalog duplicate (`antigravity-models.ts:9-15`, `antigravity.ts:1331`, `model-fallback.ts:19-21`) | P3 cleanup; every literal is still valid today.  Fold into the next catalog refresh (board 654d564b). |
| boxAgent singleton lookup ×8 | Refuted as a capability gap by verification: the lookups want the Box cloud-VM runner specifically, not "any single-instance driver".  P3: point the three inline copies (index.ts:3192, :3380, :3866) at the existing helper at :6512-6519. |
| iOS 502/504/530 gateway errors | Not a harness code defect; the harness listens on 127.0.0.1:8799 under launchd (index.ts:340, :11944), not Coolify.  Hand to an infra/reachability investigation with the Cloudflare Tunnel logs. |
| MiniMax `readChunkOrStall` retirement | Wait until Unit 7's shared idle deadline has a week in production. |

## Rows to close or comment now (no code)

- 91d45243 → completed, "Landed in #580; packaged smoke runs in per-PR CI (package.json:36)".
- 5fc628cb, 3997db1b, 4a042037 → comment with the 8a/8b split and the schema above.
- ede5d0a7 → comment "Unit 3 of claude/engine-hardening; idle timer + no relaunch on timeout + interrupted settle".
- 2c6611a1 → comment "Unit 6 (usage dims) + Unit 1 (stop_reason/setup tags); fallback attribution fields land in Unit 8b's telemetry pass".
- 64324c2c → comment "terminal_reason fix landed in #623; Unit 4 adds is_error runtime.error and 429 cooldown".
- New P0 row for the webhook-secret leak, with the rotation ask to the owner.
