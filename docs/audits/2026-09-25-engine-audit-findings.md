# Engine Audit Findings (2026-09-25)

Forty-six findings survived a three-lens adversarial check (code truth, production impact, already addressed).  Severity is the post-verification value.  The plan that groups them into units is `2026-09-25-engine-hardening-plan.md`.

| Sev | Dimension | Finding | Location | Confidence |
|---|---|---|---|---|
| P0 | efficiency | Every resumed native session gets the full system prompt again, every turn (Codex, Antigravity, Pi, and all ACP engines) | `server/drivers/pi.ts:814` | 0.85 |
| P0 | sentry-live | DSH/MiniMax-M3 capability mismatch: unsupported reasoning-effort and malformed model-option array | `harness/dsh/acp:0` | 0.80 |
| P0 | sentry-live | Antigravity 'always-proceed tool policy' issue marked resolved in Sentry but still firing in production | `server/drivers/antigravity.ts:0` | 0.75 |
| P0 | sentry-live | Sustained 502/504/530 gateway errors reported by the iOS client against the harness backend | `server/index.ts:0` | 0.30 |
| P0 | telemetry | Webhook capability secrets (whsec_…) are sent to Sentry SaaS as transaction names, culprits, and request URLs | `server/sentry.ts:326` | 0.90 |
| P1 | capability-gate | No pre-dispatch task-class gate: turns that need a desktop go out to engines that cannot get one, and are charged as normal turns | `server/index.ts:3078` | 0.85 |
| P1 | capability-gate | Automatic and configured model failover ignore capabilities: a computer, image or coding turn is handed to an engine that cannot run it | `server/turn-safety.ts:327` | 0.85 |
| P1 | capability-gate | A routine run is receipted failed (notification plus Sentry check-in false) before model failover re-runs the same prompt; the fallback's outcome is never recorded and it drops runOn | `server/index.ts:2731` | 0.80 |
| P1 | compat-flex | No minimum-CLI-version gate exists anywhere in the driver contract or install probe | `server/index.ts:5779` | 0.78 |
| P1 | efficiency | The native protocol tee redacts every stdout line synchronously and without a size cap, including session/load history replays | `server/drivers/native.ts:21` | 0.90 |
| P1 | efficiency | The replay transcript window slides one entry per turn, so providers can no longer cache the prompt once a thread passes 128 KB or 60 entries | `server/turn-context.ts:53` | 0.80 |
| P1 | efficiency | For CLI exits, the error classifier checks transient patterns before terminal ones, so hard caps are relaunched as rate limits | `server/drivers/retry.ts:176` | 0.80 |
| P1 | efficiency | Antigravity's retry has no deadline guard, so a timed-out agy turn can be relaunched into the same 10-minute hang | `server/drivers/antigravity.ts:915` | 0.50 |
| P1 | reliability | classifyError gives the same failure opposite verdicts depending on input shape, and 'unexpected status' turns 5xx/429 into terminal invalid_request | `server/drivers/retry.ts:111` | 0.90 |
| P1 | reliability | Antigravity relaunches its own 10-minute 'timeout waiting for response' as transient, so a silent agy turn can hold the bot for about 30 minutes; the 11-minute cliff has no idle detection | `server/drivers/antigravity.ts:1091` | 0.70 |
| P1 | reliability | pi: a failed set_model throws after spawn, which leaks the child and MCP credential file and wedges the thread as 'already running' | `server/drivers/pi.ts:794` | 0.85 |
| P1 | reliability | pi pipes stderr but never reads it: a chatty pi or extension can block on a full pipe, and failures carry no error text | `server/drivers/pi.ts:526` | 0.75 |
| P1 | reliability | pi swallows a failed switch_session and answers on an empty --no-session context, reported as ok=true | `server/drivers/pi.ts:773` | 0.70 |
| P1 | reliability | Grok HTTP adds its own 120s abort that races the turn loop's 180s request deadline, so slow rounds are misclassified and retried | `server/drivers/grok.ts:91` | 0.85 |
| P1 | reliability | User Stop on Claude, Codex and Antigravity settles as exit_before_result plus runtime.error, which pages Sentry for every Stop and disagrees with every other driver | `server/drivers/codex.ts:569` | 0.85 |
| P1 | reliability | ACP's new 180s idle deadline (#639) is not tool-aware, so it kills legitimate silent tool calls such as builds and test runs | `server/drivers/acp/core.ts:709` | 0.60 |
| P1 | sentry-live | Sentry issue grouping in sentry-ai.ts collapses distinct engine failure modes into a handful of catch-all issues | `server/sentry-ai.ts:558` | 0.65 |
| P1 | telemetry | A user stop on a Claude or Codex turn pages Sentry as a crash (BOTFLEET-R: "claude exited 143 before result") | `server/drivers/claude.ts:1087` | 0.85 |
| P1 | telemetry | The retained Claude session's close handler holds turn 1's closure, so a transient crash on a later turn replays turn 1's prompt and leaves the live turn open | `server/drivers/claude.ts:1066` | 0.70 |
| P1 | telemetry | Setup-class spawn failures page Sentry as the bare "bot turn failed: spawn_error" with the reason dropped (BOTFLEET-13: 146 events in 9 h, dshAgent) | `server/sentry-ai.ts:529` | 0.80 |
| P1 | telemetry | ACP "session/new timed out" (BOTFLEET-M, the top issue at 276 events) is retried as transient 120 s at a time, with no stderr or MCP-mount detail | `server/drivers/acp/core.ts:1231` | 0.80 |
| P1 | telemetry | ACP usage drops cachedRead/cachedWrite/thought tokens and usage_update.cost, so every ACP engine reports cost:null and never counts toward spend caps | `server/drivers/acp/core.ts:1331` | 0.80 |
| P2 | capability-gate | Recurring triggers have no circuit breaker: a doomed (engine, task) pair is re-dispatched on every tick indefinitely | `server/routines.ts:1209` | 0.80 |
| P2 | capability-gate | Capability flags are engine-wide booleans that mix up 'can mount' with 'has an approval channel', so they cannot serve as the capability profile the gate needs | `server/drivers/antigravity.ts:1308` | 0.80 |
| P2 | capability-gate | Peer routing is blind to capability: list_bots, ask_bot and delegate_bot expose and check nothing about what the target engine can do | `server/tools/agents.ts:60` | 0.75 |
| P2 | capability-gate | Capability degradation leaves no telemetry: a missing desktop is a transcript chip only, and no inspect endpoint or dispatcher metric exists | `server/computer-grants.ts:654` | 0.85 |
| P2 | compat-flex | Antigravity's model catalog is duplicated with no single source of truth; a refresh has already missed a copy in production | `server/antigravity-models.ts:12` | 0.82 |
| P2 | compat-flex | Workspace-containment driverKind exclusion is duplicated verbatim in two call sites instead of a driver-declared flag | `server/index.ts:3438` | 0.85 |
| P2 | compat-flex | boxAgent's singleton-instance lookup is eight separate hardcoded driverKind string matches instead of the metadata flag the contract already declares for it | `server/index.ts:3192` | 0.72 |
| P2 | efficiency | Every non-Claude CLI engine cold-spawns a process and replays its session on each turn | `server/drivers/acp/core.ts:612` | 0.85 |
| P2 | efficiency | HTTP-lane bots send up to 35 tools (21.8 KB) every round, and the two routine tools cost 5.9 KB even in unrelated turns | `server/tools/registry.ts:1124` | 0.85 |
| P2 | reliability | Claude, Codex and pi have no driver-level stall detection; the only backstop is a 20-minute harness idle watchdog, longer than any engine's own cliff | `server/index.ts:1669` | 0.80 |
| P2 | reliability | killCliTree never escalates to SIGKILL and does nothing once the CLI leader has exited, so Claude, Codex and pi MCP grandchildren can outlive the turn | `server/procs.ts:116` | 0.65 |
| P2 | reliability | HTTP turn-loop request deadline is wall-clock across an actively streaming response, so openai-compat cuts off long answers at 120s | `server/drivers/chat-completions/loop.ts:604` | 0.75 |
| P2 | reliability | Truncated answers are reported as clean successes: ACP max_tokens becomes ok=true with a null stop reason, and pi 'length' becomes end_turn | `server/drivers/acp/core.ts:1341` | 0.70 |
| P2 | sentry-live | Antigravity driver misclassifies its own SIGTERM/quiesce kill as a crash, and its 11-minute watchdog is a hard, unconfigurable timeout | `server/drivers/antigravity.ts:960` | 0.85 |
| P2 | sentry-live | Claude CLI capability probe fails closed on newer/older CLI builds instead of validating correctly | `server/drivers/claude.ts:575` | 0.70 |
| P2 | telemetry | Turn telemetry has no fallback attribution, and session.started overwrites the requested model | `server/sentry-ai.ts:407` | 0.85 |
| P2 | telemetry | A Claude is_error result emits no runtime.error, so its reason (result text, api_error_status, subtype) never reaches errors.log, Sentry, or quota classification | `server/drivers/claude.ts:960` | 0.75 |
| P3 | efficiency | computeNextOccurrence builds a new Intl.DateTimeFormat on each of up to 2,160 loop iterations | `server/model-fallback.ts:458` | 0.90 |
| P3 | telemetry | The "request_timeout" entry in EXPECTED_TURN_STOPS never matches, because chat-completions emits "timeout"; the comment describes behavior the code does not have | `server/sentry-ai.ts:333` | 0.85 |

## Details

### P0 Every resumed native session gets the full system prompt again, every turn (Codex, Antigravity, Pi, and all ACP engines)

**Location:** `server/drivers/pi.ts:814` (efficiency).  **Effort:** M.

**Evidence:** pi.ts:814 `const message = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;` is sent as the prompt after pi.ts:759-764 resumes the stored session (`send(sessionPath ? { type: "switch_session", sessionPath } : { type: "new_session" })`). The same inline happens in codex.ts:209 (`let promptText = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;`), and that prompt goes into a thread resumed with `thread/resume` at codex.ts:609. It also happens in antigravity.ts:714 (`const prompt = turn.system ? ...`), resumed with `--conversation` at antigravity.ts:822, and in acp/core.ts:1315-1319 plus every ACP support's buildPromptText (cursor.ts:459, deepseek.ts:553, droid.ts:270, dsh.ts:94, grok.ts:266, hermes.ts:463, kimi.ts:553, opencode-go.ts:385, qwen.ts:123), resumed with session/load at core.ts:1218. The harness sets `system:` unconditionally on every dispatch (index.ts:3702). It holds persona, the computer prompt, MEMORY.md up to MEMORY_MAX_BYTES=24_000 (workspace.ts:22), the skills index, playbooks, and the coordination prompts. Only Claude passes it once per session, as `--append-system-prompt` (claude.ts:620). PR #635 (port-prompt-split) touches claude/minimax/grok/openai-compat only; its diff stat shows no change to codex.ts, pi.ts, antigravity.ts, or acp/*.

**Impact:** Each turn on these 12+ engines appends another full copy of the system prompt (typically 5-30 KB, about 1.5-8K tokens) to the engine's persisted conversation. After N turns the native context holds N copies, so every later turn re-reads all of them. Token cost grows with the square of thread length. Context-window compaction also comes earlier, and the model sees stale memory and skills blocks next to current ones.

**Fix:** Deliver the system prompt out of band where the engine supports it. For Codex, use the thread/start instruction field (developer/base instructions). For Pi, use a system-prompt flag or RPC, the way claude.ts:620 does. Otherwise, in each driver (or centrally through SendTurnInput), inline `turn.system` only when no resume cursor is attached, and on resumed turns send just the volatile half when its digest changed. PR #635's buildSystemPrompt already exposes `stable`, `volatile`, and `volatileDigest`. Apply this in codex.ts sendTurn, pi.ts sendTurn, antigravity.ts sendTurn, and core.ts's default plus each AcpSupport.buildPromptText.

### P0 DSH/MiniMax-M3 capability mismatch: unsupported reasoning-effort and malformed model-option array

**Location:** `harness/dsh/acp:0` (sentry-live).  **Effort:** S.

**Evidence:** search_events (errors, dshAgent, 7d) shows: 'Invalid params: unknown reasoning effort for minimax/MiniMax-M3: max' (30+16+8+8 = 62 events across 4 hook/endpoint variants) and 'Invalid params: unknown model option: ["deepseek-official","MiniMax-M3"]' (8 events). Both are ACP protocol-level 'Invalid params' rejections from the dsh CLI, tagged gen_ai.request.model: MiniMax-M3.

**Impact:** Every turn routed to MiniMax-M3 via the DSH engine that requests reasoning-effort 'max', or that sends a two-element model-option array, is rejected outright before any model call happens -- a pure engine-capability/compatibility bug, not a transient failure.

**Fix:** Per AGENTS.md, the DSH catalog/version-gate/model-id round-trip is owned by jaywedgeworth22/Harness (imported as harness/dsh/acp) and must NOT be patched in server/drivers/acp/dsh.ts. Fix the reasoning-effort enum (drop or remap 'max' to a value MiniMax-M3 actually supports) and the model-id serialization (single string, not a 2-element array) in Harness, then bump BotFleet's git dependency on the fixed Harness version.

### P0 Antigravity 'always-proceed tool policy' issue marked resolved in Sentry but still firing in production

**Location:** `server/drivers/antigravity.ts:0` (sentry-live).  **Effort:** S.

**Evidence:** search_issues for 'tool execution policy' returns issue BOTFLEET-7 ('Antigravity: interrupted'), status=resolved, yet 91 events over 7d with last-seen 1 hour ago. search_events breakdown confirms the underlying message ('Antigravity's tool execution policy is always-proceed, which would run shell commands on this computer with nobody able to approve...') still accumulating: 39+22+6+5+5+3 = 80 events/7d across multiple bots/webhooks.

**Impact:** A safety-relevant condition (a bot's Antigravity policy lets it run shell commands with no human approval) is being spammed on effectively every turn for affected bots, and because Sentry shows it 'resolved' it is invisible to normal unresolved-issue triage -- both the underlying unsafe-policy condition and the alerting pipeline are broken.

**Fix:** Fix the root cause in server/drivers/antigravity.ts: detect the always-proceed policy once (e.g. at bot-connect time) and either block/downgrade the bot or emit a single warning breadcrumb instead of raising a captured exception on every turn. Separately, investigate why a Sentry issue with continuous new events since being marked resolved never auto-reopened (regression detection gap) so genuinely-fixed vs still-broken issues can be trusted.

### P0 Sustained 502/504/530 gateway errors reported by the iOS client against the harness backend

**Location:** `server/index.ts:0` (sentry-live).  **Effort:** M.

**Evidence:** search_events (errors dataset, 7d) filtered to botfleet.provider:'' (no engine tag, i.e. client-originated) shows: HTTP 504 = 119 events, HTTP 502 = 115 events (+8 with a UITextSelectionInteraction culprit), HTTP 530 = 44 events (+5). These are Cloudflare/edge-classified client HTTP errors (530 is a Cloudflare-specific origin-unreachable code), not tied to any one AI provider.

**Impact:** iOS app users hit gateway timeouts/bad-gateway/origin-unreachable errors on ~280 requests/week against the harness (127.0.0.1:8799/8800 behind Cloudflare Tunnel + Coolify) -- these read as the app or backend being intermittently unreachable, independent of which AI engine is in use.

**Fix:** This is very likely an infra/reliability issue rather than a single driver bug -- investigate Cloudflare Tunnel reconnect stability and Coolify container health/restarts for the BotFleet harness (server/index.ts's HTTP entrypoints on 8799/8800), and whether the harness itself is dropping connections under load (matches the previously-recorded 'harness wedge: routines.json bloat + janitor reap' incident in fleet memory). Low confidence this is a single code-level fix versus a deploy/infra stability issue.

### P0 Webhook capability secrets (whsec_…) are sent to Sentry SaaS as transaction names, culprits, and request URLs

**Location:** `server/sentry.ts:326` (telemetry).  **Effort:** S.

**Evidence:** sentry.ts:326-345 `sdk.init({ dsn, environment, tracesSampleRate, enableLogs: true, integrations: ..., sendDefaultPii: false, streamGenAiSpans: true, ... })`. There is no beforeSend, beforeSendTransaction, or httpIntegration ignore/rename hook (grep for beforeSend\|transaction\|scrub\|redact in server/sentry.ts returns nothing). webhook-ingress.ts:127 routes `/^\/hooks\/(wh_[A-Za-z0-9_-]+)(?:\/([^/]+))?$/` with the secret as the second path segment (webhookCredential at :209-214 builds `${endpointUrl}/${encodeURIComponent(secret)}`). webhook-ingress.ts:171-174 says the opposite of what happens: "the endpoint id is half of a capability URL — neither goes to Sentry". Live Sentry (org jays-services, project botfleet, last 14d): the culprit of BOTFLEET-K, BOTFLEET-T, BOTFLEET-10, BOTFLEET-6, BOTFLEET-X, BOTFLEET-R, and BOTFLEET-8 is `POST /hooks/wh_WeP8…/whsec_b_NP…`, `POST /hooks/wh_myr8…/whsec_FhuP…`, or `POST /hooks/wh_vvtR…/whsec_94Vr…`, with the full secret in the culprit. The BOTFLEET-13 event also carries `transaction` and `url` tags plus an HTTP Request block with the raw request URL, so the same happens on every event raised during a /hooks request.

**Impact:** Three live webhook secrets can now be read by anyone with access to the Sentry org, and they are kept for the full Sentry retention window. Each one is a bearer capability: anyone holding the URL can make a bot run a turn. Every new bot-turn failure that starts from a webhook leaks the secret again.

**Fix:** In server/sentry.ts initSentry, add `beforeSend` and `beforeSendTransaction` hooks. They should rewrite `event.transaction`, `event.request.url`, `event.tags.url`, `event.tags.transaction`, and span descriptions with `/\/hooks\/(wh_[A-Za-z0-9_-]+)\/[^/?\s]+/g -> '/hooks/:endpoint/:secret'`, and also redact a bare `whsec_[A-Za-z0-9_-]+`. Better, pass `sdk.httpIntegration({ ignoreIncomingRequests: (url) => url.startsWith('/hooks/') })`, or set the transaction name to a parameterized route. Add a sentry.test.ts case that feeds a /hooks URL through the hooks. Operationally: rotate the three exposed endpoint secrets and delete or scrub the affected Sentry events.

### P1 No pre-dispatch task-class gate: turns that need a desktop go out to engines that cannot get one, and are charged as normal turns

**Location:** `server/index.ts:3078` (capability-gate).  **Effort:** M.

**Evidence:** startTurn (server/index.ts:3078) runs these checks before dispatch: quiescing, bot exists, provider reload, restore lease, `if (bot.busy) throw` (:3125), `turnExternalCredentialPending` (:3178), instance exists, effort 409 (:3250). None of them looks at what the task needs. The only capability gate is inside resolveTurnComputerMounts (called at :3474). It refuses a Local VM outright (server/computer-grants.ts:622 `throw new Error("this model engine cannot use the Local VM ...")`), but for the host desktop it only degrades. computer-grants.ts:631 says "This computer is the one destination that degrades instead of refusing", and :654 is `deps.notice(`local computer not mounted: ${unavailable}`, false)`. Two cases degrade this way: an unattended Antigravity turn (:609 `unattendedAgy`, :615) and an engine whose `reach.local` is false. In both, the turn still reaches `instance.adapter.sendTurn(turnInput)` at index.ts:3746. The routine scheduler's pre-check (index.ts:3807-3817 `canStart`) only checks `turnExternalCredentialPending`.

**Impact:** Take a webhook or resource routine that asks for GUI work on an Antigravity bot with This Computer granted. It dispatches every time. It spends a full agy turn, bounded only by the 11-minute watchdog at antigravity.ts:1224, with no desktop tools. Nothing stops the same doomed (engine, task-class) pair from being dispatched again. The only trace is a transcript chip, with no counter and no refusal.

**Fix:** Add `server/capability-profile.ts`, dependency-free like computer-capability.ts. It holds `requiredCapabilities(taskClass, bot, opts)` and `doomedReason(profile, required)`. Call it in startTurn right after the instance is resolved (after the `if (!instance)` block, before the user message is appended), and in runGroupMemberTurn. When a required capability is missing and the task class is marked hard (desktop GUI, VM, images), throw a 409 with the reason. Also count `botfleet.dispatcher.doomed_skipped`. Let the RoutineManager's `canStart` consult the same function so a doomed routine run is receipted as `skipped_incapable` instead of being dispatched.

### P1 Automatic and configured model failover ignore capabilities: a computer, image or coding turn is handed to an engine that cannot run it

**Location:** `server/turn-safety.ts:327` (capability-gate).  **Effort:** S.

**Evidence:** eligibleAutoFallbackChain (server/turn-safety.ts:327-364) filters only on `instanceId !== current`, `enabled`, `snapshot.state === "available"`, `authenticated`, `quota.capped`, per-model capped and `isCooling`. `AutoFallbackCandidate` (:283-301) carries `capabilities?: { effortLevels?: readonly string[] }` and nothing else. Yet registry.describe(), which autoFallbackChain feeds it (index.ts:2863-2876), already ships `computerReach` and `capabilities.images` per instance (server/harness/registry.ts:650-667). The ladder is AUTO_FALLBACK_PRIORITY (model-fallback.ts:396): claude, antigravity, gemini, codex, minimax, openaiCompat, grok. minimax, openaiCompat and grok declare no `images` and have no image code at all (grep 'image' in minimax.ts, grok.ts, openai-compat.ts and chat-completions/* is empty). grok gets no workspace (index.ts:3442 `worksInWorkspace = instance.driverKind !== "grok" ...`), and `bash` is gated on hostComputer (tools/registry.ts:532). selectTurnFallback (model-fallback.ts:409-435) also re-dispatches a configured chain entry with no capability check. The re-dispatch at index.ts:2731-2736 sends the same `userMsg.text`, including any `<attached-image path=...>` tags.

**Impact:** Scenario 1: a Local-VM bot on Claude hits a session cap while antigravity and codex are capped. It fails over to minimax, which throws "this model engine cannot use the Local VM" (computer-grants.ts:622): the failover is spent and the turn is lost. Scenario 2: an image turn fails over to minimax or grok. The model receives a file path it cannot open and burns the turn. Scenario 3: a coding turn fails over to grok HTTP with no host computer. It has no read_file or bash at all. The image and coding cases are billed turns that cannot succeed.

**Fix:** Extend AutoFallbackCandidate with `computerReach`, `images` and `toolLoop`. Pass a `required` set (from the same `requiredCapabilities()` used by the dispatch gate) into eligibleAutoFallbackChain and filter on it. In selectTurnFallback, skip chain entries whose instance fails `required`, and advance `nextUsed` past them so they are never tried. Add `toolLoop`, `qdrantMcp` and `workspace` to InstanceInfo.capabilities (registry.ts:650) so the filter has what it needs.

### P1 A routine run is receipted failed (notification plus Sentry check-in false) before model failover re-runs the same prompt; the fallback's outcome is never recorded and it drops runOn

**Location:** `server/index.ts:2731` (capability-gate).  **Effort:** M.

**Evidence:** The settle fold calls `const routineRun = routines?.handleRuntimeEvent(event)` first (index.ts:2131). For `turn.completed` with `!event.ok`, handleRuntimeEvent runs `this.failRun(run, reason ...)` (routines.ts:1161-1162). failRun sets status 'failed', runs `checkInFinish(..., false)` and `onRunFailed`, which sends the routine-failed notification (routines.ts:1209-1223). The same fold then fails over: `void startTurn(fallbackBotId, userMsg.text \|\| "", { userMessage, threadId, modelSelection: fallbackSelection, automationSource, unattended })` (index.ts:2731-2736). It passes no `runOn` and no `onDispatchError`. When the fallback turn settles, handleRuntimeEvent looks for a run in `["running","waiting"]` (routines.ts:1128), finds none, and returns null. startTurn derives cloud execution only from `opts?.runOn` (`cloudRunUsesBoxAgent(opts?.runOn, ...)`), and resolveTurnComputerMounts uses `runOn: opts?.runOn`.

**Impact:** Every failover of a routine produces a false 'routine failed' notification and a failed Sentry cron check-in, then pays for a second engine run whose success or failure never reaches the receipt. The owner sees a failed run that may actually have succeeded. A `runOn: "cloud"` routine that fails over loses the cloud requirement: it runs on the bot's local fallback engine, in the host workspace, with the bot's local computer grants. The next queued run can also be ticked into the busy window (failRun calls `queueMicrotask(tick)`).

**Fix:** In the settle fold, decide the fallback before handing a terminal `!ok` to routines. Either call `routines.markFallingOver(threadId, nextSelection)`, which keeps the run 'running' and bumps an `attempts` field, or defer handleRuntimeEvent for turn.completed until after selectTurnFallback returns undefined. Carry `runOn` on the stored user message (or on the task's routine key) and pass it and `onDispatchError` through the fallback startTurn at index.ts:2731.

### P1 No minimum-CLI-version gate exists anywhere in the driver contract or install probe

**Location:** `server/index.ts:5779` (compat-flex).  **Effort:** M.

**Evidence:** server/index.ts:5779-5798 `testCliBinary()` (called from the `/api/cli-test` save-time probe at :10247) only resolves `{ok: true, version: stdout.trim().split("\n")[0]}` when `<cli> --version` exits zero — the captured version string is never compared to anything. `server/contracts.ts:535-551`'s `EngineInstall` interface has no `minVersion`/feature-flag field at all. Meanwhile `server/drivers/acp/droid.ts:184-189` throws `Check that \`droid\` is current (0.196.0+ supports it)...` only from inside `applySetting`'s catch block (i.e. only after a live RPC is rejected mid-turn), and `server/drivers/acp/grok.ts:238-243` does the same for `1.0.6+`. A `grep -n "snapshot.version" server/index.ts` (and a broader `.version` grep) turns up no downstream consumer of the version string `snapshot()` returns (e.g. `server/drivers/antigravity.ts:1268-1272` also just checks `if (!version)`).

**Impact:** Saving/testing a CLI path (the onboarding 'Test CLI' button) reports success for a CLI that is installed but below the version a driver actually needs (e.g. droid < 0.196.0, grok < 1.0.6). The bot then looks ready, and the person only discovers the real requirement when a specific mid-turn RPC (model switch, custom slug) is silently rejected and surfaces as a raw bot-authored error card instead of an actionable save-time message — exactly the failure mode `testCliBinary`'s own doc comment says it exists to prevent ('the single worst first-run experience'). It also means board rows 5fc628cb/3997db1b (capability profile / doomed-effort gate) have no version data plumbed anywhere to build the gate on top of.

**Fix:** Add an optional `minVersion` (and a `parseVersion`/`compare` helper) to `EngineInstall` in server/contracts.ts, have `testCliBinary` (server/index.ts:5779) compare the probed version against `driver.install.minVersion` and return a typed `tooOld` result the `/api/cli-test` response can render, and store the last-known version on the `ProviderSnapshot` so a later downgrade is caught on the next describe/snapshot cycle too, not only at save time.

### P1 The native protocol tee redacts every stdout line synchronously and without a size cap, including session/load history replays

**Location:** `server/drivers/native.ts:21` (efficiency).  **Effort:** S.

**Evidence:** native.ts:21-26 calls `appendBounded(join(NATIVE_DIR, ...), JSON.stringify({ ..., msg: redactSecrets(entry.msg) }) + "\n", NATIVE_LOG_MAX_BYTES, ...)`, and appendBounded does a synchronous `append(file, data, options)` with append defaulting to appendFileSync (transcript-retention.ts:191-203). It uses the uncapped `redactSecrets` (shared/redact.ts:1076), not `redactSecretsForLog` (shared/redact.ts:1128). Redact.ts's own comment says a 5 MB `read_file` body running every pattern "on the main thread, while every other bot's turn, the SSE fan-out and `/api/health` waited behind it" is why the event log moved to the capped variant and appendBoundedAsync (transcript-retention.ts:231-236). The tee is called on every parsed inbound line: acp/core.ts:1089 (`appendNative(threadId, { dir: "in", source: SOURCE, msg });`, before the `_meta.isReplay` drop at core.ts:976), claude.ts:862, codex.ts:544. It is also called on outbound prompts at claude.ts:524 and codex.ts:283.

**Impact:** Every streamed delta, tool result, and full-file read makes a deep regex walk plus a blocking fs write on the harness's only thread. On an ACP resume, session/load replays the whole conversation as notifications (core.ts:13-15). Each replayed line is redacted and written to disk before it is dropped, so every turn costs O(history) CPU and disk work. This stalls other bots' turns and the SSE fan-out, which matters more at the Mac's current load average.

**Fix:** In native.ts, switch to `redactSecretsForLog` and the async `appendBoundedAsync`, the way the event bus already does. In acp/core.ts, skip the tee for `session/update` notifications that arrive before `state.promptSent` or that carry `_meta.isReplay`. Also consider sampling `content.delta`-shaped chunks, or gating the tee behind a debug flag.

### P1 The replay transcript window slides one entry per turn, so providers can no longer cache the prompt once a thread passes 128 KB or 60 entries

**Location:** `server/turn-context.ts:53` (efficiency).  **Effort:** M.

**Evidence:** turn-context.ts:47-80 boundNativeTranscript keeps the newest entries within MAX_REPLAY_BYTES = 128 * 1024. It adds `{ role: "user", text: OMITTED_HISTORY }` at the head when anything is dropped. The driver then applies a second sliding cap, capReplayedTranscript (replay-cap.ts:43-46 `maxBytes: 200 * 1024, maxEntries: 60`, walking from the back and returning `transcript.slice(start)` at :130). MiniMax (minimax.ts:585-587), Grok (grok.ts:207), and OpenAI-compat (openai-compat.ts:400) build `[system, ...cappedTranscript, user]` from it. Minimax.ts's comment only promises a byte-identical prefix within one turn's rounds ("rounds 2..N re-send a byte-identical prefix"). Across turns, the first transcript message after the system prompt changes every time the window moves.

**Impact:** Past the cap, every new turn drops one or two of the oldest entries. The cached prefix then ends at the system message, and about 32K tokens of transcript are billed at the uncached rate on every turn's first round. MiniMax prices cached input at 0.06 against 0.3 uncached (minimax.ts:96-103), so that part of the prompt costs 5x. Long-running threads hit this at 30 exchanges, the most common case for bots used all day.

**Fix:** Trim in coarse steps with hysteresis instead of per turn. When the cap trips, cut the transcript down to about 50-60% of the budget at a stable boundary, and hold that start index (persisted per thread) until the budget trips again. The prefix then stays byte-identical for many turns. Also make boundNativeTranscript and capReplayedTranscript agree on one budget so two sliding windows do not stack.

### P1 For CLI exits, the error classifier checks transient patterns before terminal ones, so hard caps are relaunched as rate limits

**Location:** `server/drivers/retry.ts:176` (efficiency).  **Effort:** S.

**Evidence:** retry.ts:172-181: `if (err && "exitCode" in err) { ... for (const { pattern, reason } of TRANSIENT_PATTERNS) { if (pattern.test(text)) return { transient: true, reason }; } for (... TERMINAL_PATTERNS) ...`. The non-exit path (:186-191) checks TERMINAL first. TRANSIENT includes `/\b(?:rate.?limit\|too many requests)\b/i` (:75) and `/\boverloaded\b\|\bcapacity\b/i` (:76). TERMINAL quota includes `\brate limit reached\b` and `\bresource.?exhausted\b` (:107), so the same text "Rate limit reached" is classified quota as an Error but rate_limited as a CLI exit. The exit shape is what claude.ts:1013 (`classifyError({ exitCode: code, stderr: message })`), antigravity.ts:1191, and acp/core.ts:1132 pass on child close.

**Impact:** A CLI that dies on a hard usage or quota cap, with stderr naming a rate limit or capacity, is relaunched twice (RETRY_MAX_ATTEMPTS=3, backoff 1s/3s). For ACP engines each relaunch repeats a full cold boot: spawn, initialize, authenticate, session/load. PR #628 had to scale the initialize deadline for exactly that cost under load. The model-fallback chain only starts after those extra attempts, and the cooldown is recorded late.

**Fix:** In classifyError's exit branch, check TERMINAL_PATTERNS before TRANSIENT_PATTERNS, as the non-exit branch does, or run the quota arm first. Add retry.test.ts cases asserting that `{exitCode:1, stderr:"... Rate limit reached ..."}` and `"RESOURCE_EXHAUSTED ... capacity"` classify as terminal quota.

### P1 Antigravity's retry has no deadline guard, so a timed-out agy turn can be relaunched into the same 10-minute hang

**Location:** `server/drivers/antigravity.ts:915` (efficiency).  **Effort:** S.

**Evidence:** antigravity.ts:915-921 maybeRetry only checks `settled \|\| retryScheduled \|\| sawOutput`, cancellation, the attempt budget, and `classifyError(failure).transient`. classifyError treats `/\btimeout(ed)?\b\|\btimed? out\b/i` as transient (retry.ts:84). agy runs with `--print-timeout 10m` (antigravity.ts:806). maybeRetry is reached from an ERROR `result` with no output (antigravity.ts:1086-1093) and from any exit before result (antigravity.ts:1191). The relaunch calls `sendTurn(turn)`, which arms a fresh 11-minute watchdog (antigravity.ts:1223-1235). Compare ACP: `if (state.settled \|\| state.retrying \|\| state.deadlineTerminating) return false;` (acp/core.ts:821), whose comment says "a wedged child must not be relaunched into the same hang" (core.ts:1391-1393).

**Impact:** The hang class in board ede5d0a7 produces no stdout, so sawOutput stays false. If agy's own print-timeout surfaces as a timeout-shaped ERROR result or exit text, the turn is relaunched up to twice more. That is up to about 30 minutes of a stuck bot, with the MCP lease held for the whole time (antigravity.ts:233-236), before the fallback chain even gets a chance.

**Fix:** Port ACP's deadline guard. Record when a failure followed the print-timeout or watchdog (elapsed at least the print-timeout, or verdict.reason === "timeout") and refuse maybeRetry in that case. Settle with stopReason "timeout" so model-fallback can move on at once. Longer term, board ede5d0a7's per-stdout-line idle timer replaces both.

### P1 classifyError gives the same failure opposite verdicts depending on input shape, and 'unexpected status' turns 5xx/429 into terminal invalid_request

**Location:** `server/drivers/retry.ts:111` (reliability).  **Effort:** S.

**Evidence:** retry.ts:111 `{ pattern: /\b(?:invalid request\|malformed\|unexpected status)\b/i, reason: "invalid_request" }`. Error/text inputs check TERMINAL_PATTERNS first (retry.ts:185-190). Exit reports check TRANSIENT_PATTERNS first (retry.ts:173-181). I ran the real classifier with node --experimental-strip-types. new Error("unexpected status 503 Service Unavailable: upstream") => {transient:false, reason:"invalid_request"}. new Error("unexpected status 429 Too Many Requests") => invalid_request. The same 503 as {exitCode:1, stderr} => {transient:true, reason:"server_error"}. new Error("rate limit reached for this month") => quota (terminal), but {exitCode:1, stderr:"Error: rate limit reached for this month"} => rate_limited (transient), so the `\brate limit reached\b` quota arm at retry.ts:107 never matches an exit report. {exitCode:1, stderr:"429 Too Many Requests: You exceeded your current quota..."} => transient. new Error("stream interrupted: connection lost") => {transient:false, reason:"interrupted"}. The fake Codex app-server returns this exact error shape on RPCs (server/testing/fake-codex-app-server.ts:131,163: "unexpected status 401 Unauthorized: Missing bearer"). The transient retry test sidesteps the bug by using the wording "provider returned 503: upstream capacity exceeded" (fake-codex-app-server.ts:143).

**Impact:** A real Codex 503/429 on thread/resume or turn/start reaches codex.ts:699 `classifyError(failure)` as an Error and is classified terminal, so the relaunch built for exactly this case never runs. The turn fails, and model fallback may push the bot into a cooldown. In the other direction, ACP and Antigravity CLIs that print a monthly or plan quota message to stderr before exiting get two cold-boot relaunches with backoff. Each relaunch re-spawns the CLI and its MCP servers on a Mac already at load average 280, only to fail the same way. A mid-stream 'interrupted' is filed as a user stop and never retried.

**Fix:** In retry.ts, remove 'unexpected status' from the invalid_request arm. Let classifyByStatusCode decide on the digits, and add 'unexpected status' to HTTP_STATUS_CONTEXT so 'unexpected status 503' counts as a status cue. Use one pattern order for both input shapes: terminal quota and auth phrases first, then transient, then status codes. Change the `interrupted` arm to match only the drivers' own phrases ('interrupted by user', 'cancelled by user'). Add table tests that pass every string through all three input shapes and assert the same verdict each time.

### P1 Antigravity relaunches its own 10-minute 'timeout waiting for response' as transient, so a silent agy turn can hold the bot for about 30 minutes; the 11-minute cliff has no idle detection

**Location:** `server/drivers/antigravity.ts:1091` (reliability).  **Effort:** M.

**Evidence:** antigravity.ts:806 spawns agy with `"--print-timeout", "10m"`. At antigravity.ts:1085-1094, a `result` with no response and !sawOutput goes to `maybeRetry({ text: antigravityTurnErrorMessage(early) })`. The doc at antigravity.ts:551-556 lists agy's own "timeout waiting for response" as one of these ERROR results. classifyError({text:"Antigravity: timeout waiting for response"}) => {transient:true, reason:"timeout"} (verified by running the real classifier). maybeRetry (antigravity.ts:915-925) allows RETRY_MAX_ATTEMPTS-1 = 2 relaunches. Each relaunch arms a fresh `watchdog = setTimeout(..., 11 * 60_000)` (antigravity.ts:1225-1235), which is wall-clock with no reset on stdout activity. The harness idle watchdog (index.ts:1669, 20 min) is re-touched by each turn.retrying event, so it never fires first.

**Impact:** A provider that goes silent, which is the BOTFLEET-6 hang class, costs about 10 minutes per attempt across 3 attempts instead of failing once. The bot stays busy and the composer stays locked for about half an hour, and each relaunch re-mounts MCP under the lease. A productive turn that keeps streaming is still killed at 10 minutes by --print-timeout. A truly wedged child is found only after 11 minutes, with nothing tracking liveness in between.

**Fix:** In antigravity.ts, keep a `lastLineAt` updated in the stdout 'data' handler (antigravity.ts ~1150). Replace the single 11-minute timeout with (a) an idle timer, re-armed on every parsed line, of about 180s while no tool step is ACTIVE and a longer tool-idle window (say 8 minutes) while a step_update tool is ACTIVE, and (b) a hard maximum passed from config (promptTimeoutMs, as acp/core.ts decodes it). Raise --print-timeout to match that maximum. Emit a warning event at 80% of either window for the pre-cliff chip. In maybeRetry, return false when verdict.reason === 'timeout' so a timeout is never relaunched into the same hang. Settle idle trips with stopReason 'prompt_stall' so index.ts:2566 clears the resume cursor as it does for ACP.

### P1 pi: a failed set_model throws after spawn, which leaks the child and MCP credential file and wedges the thread as 'already running'

**Location:** `server/drivers/pi.ts:794` (reliability).  **Effort:** S.

**Evidence:** pi.ts:625 `active.set(threadId, { stop, turnId, pending, child })`. pi.ts:753 emits turn.started. pi.ts:788-800 then runs: `try { await modelPromise; } catch (error) { throw new Error(`pi refused the model ...`) }`. No settle(), no killCliTree, and no rmSync(mcpTempDir) before the throw. awaitResponse defaults to a 20s timeout (pi.ts:556), so a slow set_model under host load also lands here. The only caller, index.ts:3746 `await instance.adapter.sendTurn(turnInput)`, catches it at index.ts:3766-3772: it calls `watchdog.settle(threadId)` and never calls interruptTurn. pi.ts:482 rejects the next turn with `if (active.has(threadId)) throw new Error("a turn is already running on this thread")`.

**Impact:** One refused or slow model pin leaves several things behind. A live pi process and its MCP children (including a computer MCP) keep running. The 0600 temp file holding the box token, Composio key and comms token stays on disk. Every later message on that thread fails with 'a turn is already running' until the instance reloads, because the harness watchdog was already told to forget the turn. The Sentry invoke_agent span from turn.started never ends, and the turns map in sentry-ai.ts keeps the entry.

**Fix:** In pi.ts sendTurn, wrap everything after active.set (handshake, set_model, set_thinking_level, prompt send) in try/catch. On a throw, emit runtime.error and call settle(false, 'model_refused'). settle already kills the child, removes mcpTempDir and deletes the active entry. Then return { turnId } instead of rethrowing. Apply the same rule generally: once a driver has emitted turn.started, it must end with turn.completed, never a throw. Consider asserting that in index.ts's catch by calling instance.adapter.interruptTurn(threadId).

### P1 pi pipes stderr but never reads it: a chatty pi or extension can block on a full pipe, and failures carry no error text

**Location:** `server/drivers/pi.ts:526` (reliability).  **Effort:** S.

**Evidence:** pi.ts:524-527 `spawnCli(config.cli, childArgs, { stdio: ["pipe", "pipe", "pipe"], ...})`. `grep -c stderr server/drivers/pi.ts` returns 0. pi.ts is the only turn driver with no stderr listener (claude.ts has 13 references, codex.ts 7, antigravity.ts 8, acp/core.ts 6). procs.ts:53 attaches only `child.stdin?.on("error")`. pi.ts:747-751 `child.on("close", () => { rejectWaiters(...); settle(false); })` settles with stopReason 'failed' and emits no runtime.error, so the user sees no reason.

**Impact:** Once pi, its pi-mcp-extension, or a Node deprecation or debug logger writes about 64 KB to stderr in one turn, pi's writes block. The turn stops producing output and holds the bot until the 20-minute harness watchdog (index.ts:1669) kills it. When pi does crash, the chip and the Sentry event say only 'bot turn failed: failed', with no stderr excerpt to diagnose from.

**Fix:** In pi.ts, after spawn, add the same bounded tail every other driver has: `let stderr = ""; child.stderr.on("data", c => { stderr += c; if (stderr.length > 8192) stderr = stderr.slice(-8192); })`. In the close handler, emit runtime.error `pi exited ${code} before agent_end: ${stderrExcerpt(stderr)}` and settle(false, 'exit_before_result'). Do the same for the two snapshot and catalog spawns (pi.ts ~322 and ~835), which also pipe stderr.

### P1 pi swallows a failed switch_session and answers on an empty --no-session context, reported as ok=true

**Location:** `server/drivers/pi.ts:773` (reliability).  **Effort:** S.

**Evidence:** pi.ts:58 `const PI_ARGS = ["--mode", "rpc", "--no-session"]`. pi.ts:761-776: `try { ... awaitResponse(command) ... send({ type: "switch_session", sessionPath }) ... emit session.started } catch { // without a session we can still try a bare prompt }`. The catch emits nothing and the prompt is sent anyway (pi.ts:814). awaitResponse times out after 20s (pi.ts:556).

**Impact:** When the session file is missing, corrupt, or slow to replay under load, the bot answers with no memory of the conversation and the turn is recorded ok=true. No chip, no telemetry, and no resume-cursor reset follow, so every later turn retries the same failing switch_session and stays amnesiac without anyone knowing.

**Fix:** In pi.ts:773, when sessionPath was set and switch_session fails, do not continue silently. Either (a) fail the turn with runtime.error 'The saved pi session could not be resumed' and stopReason 'resume_failed', which index.ts:2566 already treats as clearing the resume cursor, or (b) rebuild from turn.recoveryText, as codex.ts does with recoveryPromptFor, and emit session.started with `rebuilt: true`. Raise the switch_session timeout for long sessions and scale it with host load, as acp/init-deadline.ts does.

### P1 Grok HTTP adds its own 120s abort that races the turn loop's 180s request deadline, so slow rounds are misclassified and retried

**Location:** `server/drivers/grok.ts:91` (reliability).  **Effort:** S.

**Evidence:** grok.ts:89-92 `signal: opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)`. runTurnLoop is called with no `budget` (grok.ts:273-290), so DEFAULT_TURN_LOOP_BUDGET.requestTimeoutMs = 180_000 applies (loop.ts:131). When the inner abort fires, loop.ts:652 computes `live = !turnSignal.aborted && !wallHit && !requestTimedOut` = true. retryPlanFor -> classifyError("The operation was aborted due to timeout") => {transient:true, reason:"timeout"} (verified), so it retries into the 60s left on the round deadline. If anything was published, the loop falls through to provider_error with the raw DOMException text (loop.ts:711-716) instead of the benign request_timeout. minimax.ts:414-420 documents this exact bug: "A second timer here would race it and make a timeout indistinguishable from a provider error".

**Impact:** A Grok reasoning round that is still streaming at 120s is cut off. If nothing was shown yet, a second paid request starts with only 60s to live and then fails as request_timeout, so the turn wastes about 180s and pays for two requests. If text was shown, the turn fails as 'provider_error'. sentry-ai.ts does not allowlist that, so it pages an Issue, where a real request_timeout would only leave a breadcrumb.

**Fix:** In grok.ts complete(), use `opts.signal ?? AbortSignal.timeout(180_000)`, the same pattern minimax.ts:421 and openai-compat.ts:200 use. Leave the per-round ceiling to the loop's budget. If Grok needs a different ceiling, pass `budget: { requestTimeoutMs }` to runTurnLoop.

### P1 User Stop on Claude, Codex and Antigravity settles as exit_before_result plus runtime.error, which pages Sentry for every Stop and disagrees with every other driver

**Location:** `server/drivers/codex.ts:569` (reliability).  **Effort:** S.

**Evidence:** codex.ts:307-310 `const stop = () => { stopRequested = true; killCliTree(child); }`. The close handler at codex.ts:569-578 never reads stopRequested: `emit runtime.error "codex exited ${code} before turn/completed"; settle(false, "exit_before_result")`. In claude.ts, stop (1105-1109) kills the CLI, and the close handler skips retry on retry.cancelled but still emits runtime.error and settles exit_before_result (claude.ts:1087-1093). claude.test.ts:626-633 pins this: `interrupt kills the turn ... expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" })`. In antigravity.ts, finishOnChildGone (1178-1194) emits runtime.error "agy was killed by SIGTERM before result" and settles exit_before_result after a user stop (1212-1219). By contrast, pi.ts stop settles (true, "cancelled") at pi.ts:612-624, ACP interrupt settles (true, "cancelled") at core.ts:1142, and the HTTP loop reports "interrupted". sentry-ai.ts:333 `EXPECTED_TURN_STOPS = new Set(["auth_required", "cancelled", "interrupted", "request_timeout"])`, and runtime.error is captured unless its text is on the allowlist at sentry-ai.ts:533-539.

**Impact:** Every Stop press, and every stall-watchdog stop (index.ts onStall -> interruptThreadEverywhere), on the three most-used engines creates a Sentry exception with an ok=false span. That drowns real exit_before_result crashes, which have the same stopReason and similar text, and inflates engine failure rates in any dashboard or capability gate. Fallback avoids it only through index.ts's stoppedTurns set, which is a separate code path.

**Fix:** Record the stop in each driver before killing. In codex.ts close: `if (stopRequested) return settle(false, "interrupted")` with no runtime.error. In claude.ts close: when retry.cancelled, skip the runtime.error and settle(false, "interrupted"). In antigravity.ts finishOnChildGone: when retry.cancelled, settle(false, "interrupted") silently. Pick one convention for all drivers (ok=false, stopReason 'interrupted') and change pi.ts:623 and core.ts:1142 to match. Update claude.test.ts:633. Better still for Claude and Codex, interrupt in-band instead of killing: Claude stream-json has a control_request interrupt, Codex has turn/interrupt. That keeps the warm session and its prompt cache.

### P1 ACP's new 180s idle deadline (#639) is not tool-aware, so it kills legitimate silent tool calls such as builds and test runs

**Location:** `server/drivers/acp/core.ts:709` (reliability).  **Effort:** S.

**Evidence:** core.ts:310 `const DEFAULT_PROMPT_IDLE_MS = 180_000`. armIdle (core.ts:702-716) re-checks only when a permission ask is open: `if (asks.size) { armIdle(); return; }`. Otherwise it rejects with AcpPromptIdleError. The only re-arm points are inbound stdout lines (core.ts:1094) and our replies to server requests (core.ts:673). Open tool calls (tool_call with status in_progress and no tool_call_update yet) are not tracked. On an idle trip the turn settles prompt_stall, and index.ts:2566 clears the resume cursor.

**Impact:** Most ACP agents send tool_call when a shell command starts and tool_call_update when it finishes, with nothing in between. A `pnpm test`, `xcodebuild` or `cargo build` that runs longer than 3 minutes on this loaded Mac is killed as a stall mid-command. The turn fails after doing real work, and its resume cursor is discarded, so the next turn loses the session. This regression landed with #639 on all ACP engines (DSH, Kimi, Cursor, Droid, Hermes, OpenCode, Qwen, DeepSeek, ACP Grok).

**Fix:** In core.ts handleNotification, keep `openTools: Set<toolCallId>`: add on tool_call when status is pending or in_progress, delete on tool_call_update when status is completed or failed. In armIdle, when openTools.size > 0, use a longer tool-idle window (a new promptToolIdleMs, default about 10 minutes, capped by the 18-minute maximum) instead of 180s. Add a fake-acp-cli test with a 200s silent tool step using scaled timers.

### P1 Sentry issue grouping in sentry-ai.ts collapses distinct engine failure modes into a handful of catch-all issues

**Location:** `server/sentry-ai.ts:558` (sentry-live).  **Effort:** S.

**Evidence:** search_issues for 'initialize timed out' (a dshAgent-only message per the events breakdown) returns issue BOTFLEET-M, whose latest/title event is actually 'grokAgent exited null before the prompt result' (grokAgent, x_ai/grok-4.6). Both very different providers/messages are grouped under the same issue because sink.captureException(...) at sentry-ai.ts:558/594/543 relies on Sentry's default stack-frame fingerprinting, which is identical for every provider (same throw site in observeRuntimeEvent) regardless of the actual provider or stop reason.

**Impact:** Per-engine reliability is invisible from the Issues list: a spike in one specific engine's failures (e.g. grok crashing) can hide inside an issue whose title and history are dominated by a different engine's timeouts, undermining the telemetry this task was asked to evaluate.

**Fix:** Pass an explicit Sentry fingerprint (e.g. ['bot-turn-failure', provider, stopReason]) on every sink.captureException call in server/sentry-ai.ts (observeRuntimeEvent, around lines 517-594) instead of relying on default grouping, so each (engine, failure-mode) pair gets its own issue.

### P1 A user stop on a Claude or Codex turn pages Sentry as a crash (BOTFLEET-R: "claude exited 143 before result")

**Location:** `server/drivers/claude.ts:1087` (telemetry).  **Effort:** S.

**Evidence:** The stop path is `const stop = () => { retry.cancelled = true; retryAbort.abort(); killCliTree(child); }` (claude.ts:1105-1109). A retained session stops with `killCliTree(live.child)` alone (:731). The close handler at :1011-1093 never looks at `retry.cancelled` before `emit({ type: "runtime.error", message })` (:1088-1092) and `settle(false, "exit_before_result")` (:1093). The test pins this shape: claude.test.ts:626-633 `interrupt kills the turn ... toMatchObject({ ok: false, stopReason: "exit_before_result" })`. Codex has the same flaw: codex.ts:307-310 sets `stopRequested` and kills the child, then close at :569-577 emits runtime.error "codex exited … before turn/completed" without checking stopRequested. index.ts:2617-2620 knows about this ("the driver reports this settle as `exit_before_result`") and consumes `stoppedTurns` for fallback only. sentry-ai.ts subscribes straight to the bus (index.ts:519) and captures every runtime.error that is not on its expected list (sentry-ai.ts:529-561). Live Sentry: BOTFLEET-R "claude exited 143 before result" (143 = SIGTERM from killCliTree) has 9 events and is set to ignored.

**Impact:** Each Stop press on a Claude or Codex bot raises a Sentry exception. The span is also marked internal_error and the errors.log line reads like a crash. Someone has already ignored the issue by hand, so a real Claude "exited 143" (for example an OOM kill from outside) is now muted as well.

**Fix:** claude.ts close handler: when `retry.cancelled` is set, skip runtime.error and call `settle(false, "interrupted")`. Make the retained-session stop at :731 set a per-turn cancelled flag too (see the next finding). codex.ts:569-577: when `stopRequested` is set, call `settle(false, "interrupted")` with no runtime.error. Update claude.test.ts:633 to expect `stopReason: "interrupted"`. sentry-ai.ts already treats "interrupted" as an expected stop (EXPECTED_TURN_STOPS at :333).

### P1 The retained Claude session's close handler holds turn 1's closure, so a transient crash on a later turn replays turn 1's prompt and leaves the live turn open

**Location:** `server/drivers/claude.ts:1066` (telemetry).  **Effort:** M.

**Evidence:** The close handler is registered once, at spawn, inside the first sendTurn call. It closes over that call's `turn`, `turnId`, and `retry` (retry is built at :592-594). A later turn reuses the process through the fast path at :727-745: `live.turn = {turnId,...}; active.set(threadId, { stop: () => killCliTree(live.child), ... })`. That path registers no new close handler and never sets the old `retry.cancelled`. If the process then dies with a non-zero code, a stderr excerpt that matches a TRANSIENT_PATTERN (retry.ts:72-88, including `/\btimeout(ed)?\b\|\btimed? out\b/`), and no stream delta yet, the handler emits `turn.retrying` with the stale `turnId` (:1038-1044) and runs `await sendTurn({ ...turn, resumeCursor: cursor })` (:1066). Here `turn` is the FIRST turn's SendTurnInput. `session.turn = null` (:1035) means the live turn's turn.completed is never sent. session.stderr keeps up to 8192 bytes across the whole session life (:997-999), so stderr from an earlier turn can make the text look transient. The Stop-button variant of this is closed off only when the stderr text happens not to match.

**Impact:** The bot re-runs the previous prompt and can repeat its tool actions: paid tokens and possibly a destructive replay. The real turn never settles and waits for the turn watchdog. Telemetry puts the retry on the wrong turnId.

**Fix:** Stop capturing per-turn state in the spawn-time closure. Store `{ turnId, input: SendTurnInput, retry }` on `session.turn` and have the close handler read `session.turn.input` and `session.turn.retry`. Make the retained-path stop at :731 set `session.turn.retry.cancelled = true` before killCliTree. Add a claude.test.ts case: two turns on one retained process, the second exits 1 with "overloaded" on stderr, and the test asserts the relaunch carries the second turn's text and turnId.

### P1 Setup-class spawn failures page Sentry as the bare "bot turn failed: spawn_error" with the reason dropped (BOTFLEET-13: 146 events in 9 h, dshAgent)

**Location:** `server/sentry-ai.ts:529` (telemetry).  **Effort:** S.

**Evidence:** procs.ts:105-110 makes ENOENT/EACCES `{ message: "`cli` isn't installed, or isn't on this app's PATH", setup: true }`. core.ts:1122-1125 `child.on("error", (e) => { emit({ type: "runtime.error", ...describeSpawnFailure(e, config.cli) }); settle(false, "spawn_error"); })`. sentry-ai.ts:535-546 turns `event.setup` into a breadcrumb only and does not add the key to reportedProviderErrors. turn.completed at :565-597 then finds "spawn_error" missing from EXPECTED_TURN_STOPS and calls `captureException(new Error(`bot turn failed: ${stopReason}`))`. Live BOTFLEET-13 event 20a05dff…: stack `ChildProcess._handle.onexit -> acp/core.ts settle(false, "spawn_error") -> sentry-ai.ts:594`, tags `botfleet.provider: dshAgent`, `gen_ai.request.model: MiniMax-M3`, `botfleet.bot.name: Compiler`, 146 occurrences and 6 bots between 13:48Z and 22:39Z on 2026-09-25. failureTags (:356-371) has no stop_reason or setup tag.

**Impact:** The busiest new issue says nothing actionable, because the "dsh isn't installed / not on PATH" text is only in a breadcrumb. The setup:true design ("do not page") is undone one event later. 146 dispatches to an engine that cannot even spawn show that nothing stops scheduling onto a dead engine. That is the doomed-effort gap in board 5fc628cb.

**Fix:** In sentry-ai.ts, remember setup runtime.errors per turn key, like initTimeoutTurns. On turn.completed, either treat the stop as expected (a warning-level captureMessage fingerprinted by provider plus "setup") or capture with the saved message as the exception text. Add `botfleet.stop_reason` and `botfleet.setup` to failureTags. Separately, have the dispatcher refuse a bot whose activity is "dead" from a setup failure until its engine snapshot changes (board 5fc628cb, metric botfleet.dispatcher.doomed_skipped).

### P1 ACP "session/new timed out" (BOTFLEET-M, the top issue at 276 events) is retried as transient 120 s at a time, with no stderr or MCP-mount detail

**Location:** `server/drivers/acp/core.ts:1231` (telemetry).  **Effort:** S.

**Evidence:** core.ts:300 `const NEW_SESSION_TIMEOUT = 120_000;` and :1231 `sessionResult = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT)`. On timeout the error text is only `session/new timed out`, because AcpRpcTimeoutError at :724 gets no detail, unlike initialize at :1182-1183, which gets describeInitDeadline. classifyError matches `/\btimed? out\b/` as transient (retry.ts:87). The only relaunch cap is for initialize (`initRelaunchSpent = initTimedOut && ...` at :1397), so maybeRetry (:820-837) relaunches session/new up to RETRY_MAX_ATTEMPTS-1 = 2 more times, a cold spawn plus 120 s each time. The final runtime.error at :1404-1409 includes neither stderr (kept at :1117-1120) nor the mcpServers count. Live Sentry, 14 d: BOTFLEET-M has 183 events for dshAgent/MiniMax-M3, 44 for grokAgent/grok-4.6, 27 for dshAgent/deepseek-v4-pro, and 22 for dshAgent/deepseek-v4-flash.

**Impact:** A failed turn can burn up to about 6 minutes and three cold CLI boots, each mounting every MCP server, before it fails. The fallback chain then starts over on another engine. With no stderr and no mount list in the event, nobody can tell whether the stall is DSH auth, an MCP server that hangs on connect (compare the grok/dsh-mcp-mounts lane), or host load.

**Fix:** core.ts: give session/new a detail string like initialize's (elapsed time, mcpServers.length, server names, and the last 300 bytes of stderr), redacted with redactSecretsInText. Cap session/new timeouts at one relaunch, as MAX_INIT_TIMEOUT_RELAUNCHES does for initialize. Add `botfleet.acp.method` and `botfleet.mcp_server_count` tags to the runtime.error.

### P1 ACP usage drops cachedRead/cachedWrite/thought tokens and usage_update.cost, so every ACP engine reports cost:null and never counts toward spend caps

**Location:** `server/drivers/acp/core.ts:1331` (telemetry).  **Effort:** M.

**Evidence:** core.ts:1329-1341: `const usage = result?.usage ?? result?._meta ?? {}; if (typeof usage.inputTokens === "number" ...) turnUsage = { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 }`. The ACP SDK 1.4.0 Usage type (node_modules/.pnpm/@agentclientprotocol+sdk@1.4.0…/dist/v2/schema/types.gen.d.ts:3614-3641) also carries `totalTokens`, `thoughtTokens`, `cachedReadTokens`, and `cachedWriteTokens`, and all four are dropped. usage_update at core.ts:1047-1066 reads only `u.used`, although the UsageUpdate schema (types.gen.d.ts ~:4231-4239) has `size` and `cost?: { amount, currency }` ("Cumulative session cost"). Every ACP settle emits `cost: null` (core.ts:550, :801, :869, :892). index.ts:2685 `if (typeof event.cost === "number" && event.cost > 0) rollingSpendTracker.recordTurn(...)`, so ACP turns never reach the rolling-spend tracker. Sentry spans set gen_ai.usage.input_tokens.cached only when cachedInput is present (sentry-ai.ts:320, :519-521).

**Impact:** DSH, Kimi, Cursor, ACP Grok, OpenCode Go, Hermes, and Droid turns are free in spend caps and usage attribution even when the agent reports a cost. Cached input is counted as full-price input, and reasoning tokens are not counted. Usage Monitor and Sentry AI dashboards under-report ACP spend.

**Fix:** core.ts :1331: `turnUsage = { input: inputTokens + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0), output: outputTokens + (thoughtTokens ?? 0), ...(cachedReadTokens != null ? { cachedInput: cachedReadTokens } : {}) }`. Match claude.ts:969-974, where input includes cache reads and cachedInput names them, and first confirm per engine whether inputTokens already includes cache. core.ts :1047: keep `u.cost` when `currency === "USD"`, store the delta from the previous cumulative amount on the session, and pass it as `cost` with `billingMode: "estimated"` on turn.completed. Record `u.size` as `gen_ai.request.context_window`. Add a price-table estimate in index.ts for ACP turns that report tokens but no cost.

### P2 Recurring triggers have no circuit breaker: a doomed (engine, task) pair is re-dispatched on every tick indefinitely

**Location:** `server/routines.ts:1209` (capability-gate).  **Effort:** S.

**Evidence:** failRun (routines.ts:1209-1223) sets status and error, checks in, saves, emits, and calls onRunFailed. It keeps no consecutive-failure count and has no auto-pause. grep for 'streak\|consecutive' in routines.ts finds nothing, and `routine.enabled = false` appears only for `once` schedules (:940) and disableForBot (:703-707). Cadence: resource triggers default to a 45-minute cooldown (resource-triggers.ts:394 `cooldownMinutes ?? 45`). Webhook minGapMinutes defaults to 0 (webhooks.ts:282). Daily schedules fire every selected weekday. Per-run worst case before a failure settles: up to 3 driver launches while nothing has been output (RETRY_MAX_ATTEMPTS=3; claude.ts:1019, acp/core.ts:830, antigravity.ts:918), plus one hop per configured chain entry (selectTurnFallback, model-fallback.ts:424-431). Each is capped by that engine's clock: agy 11 min (antigravity.ts:1224), ACP 18 min wall / 180 s idle (acp/core.ts:305,310), claude/codex 15 min, MiniMax 900 s with a 120 s idle stall, harness stall 20 min (index.ts:1669).

**Impact:** A resource-triggered bot bound to an engine that cannot do its task burns a turn every 45 minutes, about 32 doomed turns a day. With a two-entry fallback chain on ACP engines, each storm can hold the bot busy for up to about 54 minutes (3 × 18) while blocking real work. Owners get a routine-failed notification each time with no escalation.

**Fix:** Add `consecutiveFailures` per routine, keyed by (routineId, engineId, outcomeCode), in RoutineManager.failRun, and reset it on a completed run. After N=3 failures with the same capability or doomed code, set `routine.pausedReason = "incapable"`, skip dispatch in tick, and send a single notification. Emit `botfleet.routine.auto_paused`. Surface the reason in the Routines UI.

### P2 Capability flags are engine-wide booleans that mix up 'can mount' with 'has an approval channel', so they cannot serve as the capability profile the gate needs

**Location:** `server/drivers/antigravity.ts:1308` (capability-gate).  **Effort:** M.

**Evidence:** contracts.ts:437-439 on localComputerMcp says "an engine with no approval channel at all must leave this false". Antigravity declares `computerMcp: true, localComputerMcp: true` (antigravity.ts:1307-1308) while `respondToRequest: async () => "unavailable"` (:1316). Its own comment (:1291-1302) admits shell asks are auto-denied with no card. Separately, ProviderAdapter.capabilities (contracts.ts:400-458) sits on the adapter, not on ModelCatalog options. The only per-model capability is `effortLevels` (contracts.ts:569-572), so 'images on model X but not model Y' cannot be expressed. InstanceInfo.capabilities (harness/registry.ts:650-660) drops `toolLoop`, `qdrantMcp` and `replaysTranscript`. On the ACP side, every engine's MCP flags collapse to one `support.mcpServers !== false` boolean (acp/core.ts:1440, 1458-1465), and no engine file sets mcpServers:false. So DSH is advertised with the full MCP set, which contradicts wisdom row 4a042037 ("not full toolset even with MCP flag").

**Impact:** The Settings badges and the planned /api/inspect/capabilities would report Antigravity as able to use This Computer with approvals, and DSH as having the full MCP toolset, neither of which holds in practice. A gate built on today's flags would let exactly the doomed combinations board 4a042037 lists get through.

**Fix:** Add a `profile?: (model: string) => CapabilityProfile` to ProviderInstance, with the adapter flags as the default. CapabilityProfile = { transport: ComputerTransport\|null, approvals: 'broker'\|'auto-deny'\|'none', mcp: {mounted: boolean, verified: boolean}, images, steer: queueing, dweb: boolean, workspaceTools, shell, effortLevels }. Antigravity returns approvals:'auto-deny'. DSH returns mcp.verified:false until the GROK lane (3bfa4c2c) lands. Ship the whole profile in InstanceInfo.

### P2 Peer routing is blind to capability: list_bots, ask_bot and delegate_bot expose and check nothing about what the target engine can do

**Location:** `server/tools/agents.ts:60` (capability-gate).  **Effort:** S.

**Evidence:** selectPeerBots (tools/agents.ts:60-78) returns `{ id, name, model: bot.modelSelection.model, busy, title, description }`, with no engine kind, computers or capability flags. executeAskBotRequest (index.ts:4381-4437) checks self, depth, hidden, busy (:4398), section and approval, then dispatches. executeDelegateBotRequest (index.ts:4446 onward) and delegations.ts processOne (:229-297) check existence, busy, section and approval only. The target's startTurn applies no task gate either (finding 1).

**Impact:** A Chief-of-Staff or peer bot asked to 'take a screenshot' or 'click through the app' cannot tell which peer holds a computer or runs an engine that reaches one. It picks by name or title, and the peer's turn runs doomed: a desktop-degraded notice and a billed turn, or a Local-VM throw. Each hop is a full turn on both bots.

**Fix:** Add `engine: instance.driverKind`, `computers: bot.computers` and a compact `can: ['desktop','vm','cloud','images','shell','mcp']` array (derived from the CapabilityProfile and the bot's grants) to AgentPeerRow in selectPeerBots. In executeAskBotRequest and executeDelegateBotRequest, accept an optional `needs` argument. If the target's profile lacks a hard requirement, return `{ error: 'incapable', missing: [...] }` before the approval card.

### P2 Capability degradation leaves no telemetry: a missing desktop is a transcript chip only, and no inspect endpoint or dispatcher metric exists

**Location:** `server/computer-grants.ts:654` (capability-gate).  **Effort:** S.

**Evidence:** The only runtime signal when a granted computer is not mounted is `deps.notice(`local computer not mounted: ${unavailable}`, false)` (computer-grants.ts:654) and `deps.notice(`VPS computer not mounted: ...`)` in the VPS branch. Both become activity messages in the store. The whole server makes exactly one metrics call, `getSentry()?.metrics.count("usage_telemetry.outbox", ...)` (telemetry.ts:464). grep for 'api/inspect\|capabilityProfile\|wisdom' across server, src and shared finds nothing. telemetry.trackTurn (index.ts ~2695-2717) records instance, model, tokens and success, but not the required versus mounted capabilities.

**Impact:** How often turns run on engines that could not do them, the thing the P1 capability-gate rows ask to measure, cannot be counted today. The Sentry turn spans and the usage-telemetry rows have no field recording that a turn ran without its computer.

**Fix:** In resolveTurnComputerMounts, return `degraded: Array<{kind, reason}>` next to mounts. In startTurn and the room lane, count `botfleet.dispatcher.capability_degraded` with attributes {engine, kind, reason}, guarded by `isSentryActive()` as in telemetry.ts:463-466. Add `requiredCaps` and `mountedCaps` to TelemetryTurnParams (telemetry.ts:17). Add `GET /api/inspect/capabilities` next to `GET /api/instances` (index.ts ~10201): it returns per-(instance, model) profiles plus the doomed-policy table.

### P2 Antigravity's model catalog is duplicated with no single source of truth; a refresh has already missed a copy in production

**Location:** `server/antigravity-models.ts:12` (compat-flex).  **Effort:** S.

**Evidence:** server/antigravity-models.ts:9-15: "Aligned 2026-09-24 with the `agy` build the driver itself documents... The September 18 refresh (PR #485) updated four driver catalogs and missed this one, which is how the header came to claim 1.1.23 — whoever refreshes the fleet's catalogs next, this file is the fifth..." Separately, `server/drivers/antigravity.ts:1331` hardcodes a sixth, independent literal for the cheap generateText call: `["-p", prompt, "--output-format", "text", "--model", "gemini-3.6-flash-low"]`, not derived from `STATIC_ANTIGRAVITY_MODELS` (server/antigravity-models.ts:18-34) that it duplicates.

**Impact:** Model-catalog refreshes are a manual, per-file exercise across at least 5-6 locations (four+ driver catalogs, this fallback file, and this generateText literal); the in-repo comment documents that exactly this class of refresh already skipped a file once and shipped a stale header/version claim to production. The next catalog rename (e.g. retiring the gemini-3.6 line) can silently break `generateText` (used for bot titles/summaries) without touching any test that only exercises the main catalog.

**Fix:** Make `STATIC_ANTIGRAVITY_MODELS` (or a small derived constant, e.g. a `UTILITY_MODEL` export like minimax.ts:137 already does) the only place a concrete Gemini model id is spelled, and have antigravity.ts:1331 read from it instead of a fresh string literal. Consider a single generated manifest (one JSON/TS file) that every driver catalog and its generateText/utility-model constant import from, so a fleet-wide catalog refresh is one edit instead of five.

### P2 Workspace-containment driverKind exclusion is duplicated verbatim in two call sites instead of a driver-declared flag

**Location:** `server/index.ts:3438` (compat-flex).  **Effort:** S.

**Evidence:** server/index.ts:3438: `const worksInWorkspace = instance.driverKind !== "grok" && instance.driverKind !== "boxAgent";` — identical to server/index.ts:5009's `const worksInWorkspace = instance.driverKind !== "grok" && instance.driverKind !== "boxAgent";`, whose own comment (index.ts:5006-5008) reads: "same workspace + memory as a 1:1 turn... The exclusions match the 1:1 lane's exactly, `grok` included; see the comment there for why widening it is held behind confining the workspace file tools."

**Impact:** The known P0 containment gap this expression guards (board row 9998f9a9 — workspace file tools have no path-containment check, so `worksInWorkspace` is the only thing standing between an engine and reading `~/.botfleet/config.json`) is enforced by two hand-synchronized string comparisons rather than one driver-declared boolean. A fix to the P0 (confining the tools) or the addition of a new remote/no-filesystem engine has to remember to touch both call sites — nothing in the type system or a single source of truth ties them together, and the 1:1-vs-room comment pointer is the only thing keeping them aligned today.

**Fix:** Add a driver-declared capability (e.g. `hasLocalWorkspace?: boolean` on `ProviderAdapter.capabilities` in server/contracts.ts, false for `boxAgent` and `grok`) and replace both `instance.driverKind !== "grok" && instance.driverKind !== "boxAgent"` expressions with a single `computerCapabilityStyle` helper (mirroring server/computer-capability.ts's existing pattern) that reads it.

### P2 boxAgent's singleton-instance lookup is eight separate hardcoded driverKind string matches instead of the metadata flag the contract already declares for it

**Location:** `server/index.ts:3192` (compat-flex).  **Effort:** S.

**Evidence:** `grep -n 'driverKind === "boxAgent"' server/index.ts` finds 8 hits: index.ts:3192, 3380, 3705, 3765, 3866, 3918, 5173, 6517 — e.g. index.ts:3192 `? registry.instances().find((candidate) => candidate.driverKind === "boxAgent") ?? null` and index.ts:6517 `return registry.instances().find((candidate) => candidate.driverKind === "boxAgent") ?? null;`. `grep -n "supportsMultipleInstances: false" server/drivers/*.ts server/drivers/acp/*.ts` returns exactly one hit — server/drivers/boxagent.ts:51 `metadata: { displayName: "Computer", supportsMultipleInstances: false }` — i.e. boxAgent is the only driver whose contract already declares 'there is exactly one of these', yet none of the 8 call sites read that flag; each re-derives 'the one box instance' by matching the literal string.

**Impact:** This is exactly the kind of per-driverKind hardcoding a capability profile (board rows 5fc628cb/4a042037) is meant to replace. Today, adding a second singleton-style engine (e.g. another remote/box-style agent) requires finding and updating all 8 literal-string call sites by hand; missing one produces a UI branch that silently keeps treating the old box driver as 'the' singleton while a new singleton driver's instance is invisible to those code paths.

**Fix:** Add a `registry.singletonOf(driverKind)` (or `registry.singleton()` reading `metadata.supportsMultipleInstances === false`) helper and replace all 8 `driverKind === "boxAgent"` lookups in server/index.ts with a call to it, keyed off `BoxAgentDriver.driverKind` instead of the bare string literal.

### P2 Every non-Claude CLI engine cold-spawns a process and replays its session on each turn

**Location:** `server/drivers/acp/core.ts:612` (efficiency).  **Effort:** L.

**Evidence:** acp/core.ts:612-620 calls `spawnCli(spawned.cli, spawned.args, ...)` inside every sendTurn. It then runs `initialize` (:1175), `authenticate` (:1198, plus an optional `isAuthenticated` probe spawn at :1203-1208), and `session/load`, which replays history (:1216-1220, core.ts:13-15). Codex spawns a fresh `app-server` per turn (codex.ts:259) and calls `thread/resume` (codex.ts:609). Pi spawns per turn (pi.ts:527), then sends switch_session and set_model. Antigravity spawns agy per turn with `--conversation`. Only Claude keeps a warm process: claude.ts:465-467 "a session is spawned once, reused while its spawn contract ... is unchanged, closed after SESSION_IDLE_MS of quiet".

**Impact:** Each turn on 12+ engines pays CLI cold boot, MCP server startup, auth, and a full history replay before the first token. PR #628 had to scale the initialize deadline for heavy cold boots under host load, and every transient-retry relaunch repeats all of it. Combined with the synchronous tee finding above, the replay also costs CPU on the harness thread.

**Fix:** Add a per-thread warm-session cache to acp/core.ts, keyed on the spawn contract (cli, args, env digest, cwd, mcpServers digest, model), with an idle close. Mirror claude.ts's Session and SESSION_IDLE_MS design, and send a new session/prompt on the live sessionId instead of respawning and running session/load. Do the same for the codex app-server (turn/start on a live thread).

### P2 HTTP-lane bots send up to 35 tools (21.8 KB) every round, and the two routine tools cost 5.9 KB even in unrelated turns

**Location:** `server/tools/registry.ts:1124` (efficiency).  **Effort:** M.

**Evidence:** registry.ts:1124-1131 httpToolDefinitions maps `toolsFor("http", ctx)`. buildTurnTools (turn-tools.ts:29-55) gates only on integration booleans, and github_* rides localComputer (turn-tools.ts:48 `github: Boolean(integrations.localComputer)`). Measured by importing the registry with every gate on: `count 35 bytes 21789`. With agents only: 7 tools and 8,713 bytes, of which propose_routine is 2,882 bytes and propose_routine_action is 3,042 bytes. Both embed ROUTINE_FIELDS_SCHEMA and are gated on `anyAgentsBot` (registry.ts:418-460). Each round resends them (minimax.ts:652 `tools: openAiTools`, up to maxRounds: 12 in loop.ts:130).

**Impact:** That is roughly 5.5K tokens of tool schema per model round for a computer-plus-agents bot, and about 2.2K tokens for any agents-enabled bot. At 12 rounds per turn, schema can outweigh the conversation on short turns. Cache hits soften this only while the tool list and the preceding prefix stay byte-identical, which the sliding-window finding above undermines.

**Fix:** Carry the skill/intent selection the dispatch already computes (the phoneEligible pattern at index.ts:3606-3609) into the catalog. Offer the propose_routine* tools only when the routine skill or intent matched, and the 11 github_* tools only when the message mentions a repo or PR, or behind a single `github` dispatcher tool. Deduplicate ROUTINE_FIELDS_SCHEMA by making propose_routine_action's `changes` reference a shorter description.

### P2 Claude, Codex and pi have no driver-level stall detection; the only backstop is a 20-minute harness idle watchdog, longer than any engine's own cliff

**Location:** `server/index.ts:1669` (reliability).  **Effort:** M.

**Evidence:** index.ts:1669 `const TURN_STALL_MS = Math.max(60_000, Number(process.env.OMB_TURN_STALL_MS) \|\| 20 * 60_000)`. claude.ts has no per-turn timer: grep finds only SESSION_IDLE_MS (claude.ts:487, closes idle sessions between turns) and the permission-ask timers. codex.ts has only the RPC handshake timeout (codex.ts:285, 60s); after turn/start nothing is timed. pi.ts has only the 20s awaitResponse (pi.ts:556). By contrast, ACP has a 180s idle and an 18-minute max (core.ts:303-310), the HTTP loop has 120-180s per round (loop.ts:604), and MiniMax unattended has a 120s stream idle (minimax.ts:60).

**Impact:** A Claude or Codex turn whose MCP tool hangs (for example a dead computer daemon or a stuck phone bridge), or whose provider stream stops without closing the socket, holds the bot busy with the composer locked for 20 minutes before anything happens. The eventual kill then reports as exit_before_result, not as a stall. The timeout can be tuned only globally through an env var, not per engine or per bot.

**Fix:** Factor core.ts's armIdle into a shared helper, e.g. server/drivers/idle-guard.ts: `createIdleGuard({ idleMs, toolIdleMs, onTrip })` with touch(), toolStarted(id) and toolEnded(id). Wire it into the stdout line handlers of claude.ts (~979), codex.ts (~535) and pi.ts (~724), and into the antigravity handler. On a trip: emit runtime.error '<engine> produced no output for N and was stopped as a stall', kill with SIGKILL escalation, and settle 'prompt_stall'. Expose idleMs, toolIdleMs and maxMs in each driver's decodeConfig, as ACP does with promptIdleMs and promptTimeoutMs. Keep the harness 20-minute watchdog as the last resort.

### P2 killCliTree never escalates to SIGKILL and does nothing once the CLI leader has exited, so Claude, Codex and pi MCP grandchildren can outlive the turn

**Location:** `server/procs.ts:116` (reliability).  **Effort:** S.

**Evidence:** procs.ts:116 `if (!pid \|\| child.exitCode !== null \|\| child.signalCode !== null) return;` and procs.ts:131-132 `process.kill(-pid, "SIGTERM")`, with no follow-up. ACP adds its own escalation: core.ts:753 "an MCP descendant can ignore SIGTERM and outlive its parent", then `process.kill(-pid, "SIGKILL")` after FORCE_EXIT_AFTER_MS. antigravity.ts:870-889 arms the same 3s SIGKILL. claude.ts (closeSession 505-506, stop 1105-1109), codex.ts (stop 307-310, settle 320) and pi.ts (settle 598, stop 619) call bare killCliTree only. codex.ts:320 `stop(); // the app-server never exits on its own` runs on every settle. If the app-server has already exited, the early return means the process group is never signalled.

**Impact:** The computer, phone, Composio and Qdrant MCP proxies spawned by Claude, Codex and pi share the CLI's process group. One that ignores or delays SIGTERM, or whose leader died first, is left orphaned and keeps holding sockets, box leases and file handles. Orphans pile up across hundreds of turns on a Mac already at load average 280. antigravity.ts:1197-1203 documents MCP grandchildren outliving agy, so this is an observed behavior, not a theoretical one.

**Fix:** Add a `killCliTreeHard(child, graceMs = 2000)` to procs.ts. It sends SIGTERM to -pid even when the leader has exited (the process group can outlive the leader; catch ESRCH), then after graceMs sends SIGKILL to -pid unconditionally. Use it in claude.ts closeSession and stop, codex.ts stop and settle, and pi.ts settle and stop. Replace the private escalations in core.ts and antigravity.ts with it so there is one implementation.

### P2 HTTP turn-loop request deadline is wall-clock across an actively streaming response, so openai-compat cuts off long answers at 120s

**Location:** `server/drivers/chat-completions/loop.ts:604` (reliability).  **Effort:** M.

**Evidence:** loop.ts:602-607 `const requestTimer = setTimeout(() => { requestTimedOut = true; request.abort(); }, budget.requestTimeoutMs);` is armed once per round. onPublished (loop.ts:637-639) only sets `published = true` and never extends the deadline. openai-compat.ts:503 passes `budget: { requestTimeoutMs: REQUEST_TIMEOUT_MS }` with REQUEST_TIMEOUT_MS = 120_000 (openai-compat.ts:30). MiniMax had to widen the ceiling to 900s for unattended turns and add a separate stream-idle guard to escape the same problem (minimax.ts:46-60, 742).

**Impact:** An OpenRouter, Groq or local model streaming a long answer or a large tool-call argument (a whole-file write) is aborted mid-stream at 120s, even though bytes are flowing. The turn fails as request_timeout after the tokens were already generated and billed, and the replay safety rule then forbids retrying it.

**Fix:** Split the budget in loop.ts into requestTimeoutMs (a hard ceiling, raised to about 600s) and a new requestIdleMs (default 120s) that resets on every onPublished call and on every raw chunk. To see raw chunks, add an `onChunk` callback to runRound's opts, called from the SSE reader loops in grok.ts, minimax.ts and openai-compat.ts. Then retire minimax's special unattended widening and readChunkOrStall in favour of the shared idle guard.

### P2 Truncated answers are reported as clean successes: ACP max_tokens becomes ok=true with a null stop reason, and pi 'length' becomes end_turn

**Location:** `server/drivers/acp/core.ts:1341` (reliability).  **Effort:** S.

**Evidence:** core.ts:1341 `if (reason === "end_turn" \|\| reason === "max_tokens") settle(true, null);`. pi.ts:707-718: every stop reason other than toolUse, error or failed goes to `settle(true, sr === "cancelled" \|\| sr === "aborted" ? "cancelled" : "end_turn", usage)`, so pi-ai's 'length' is recorded as end_turn.

**Impact:** When a model hits its output cap mid-answer or mid-tool-call, the turn is recorded as a normal completion. The UI cannot show a truncated chip, routines receive a cut-off result marked successful, and the capability and wisdom registries (5fc628cb, 4a042037) cannot learn which engine and model pairs truncate. Nothing auto-continues.

**Fix:** In core.ts:1341, settle(true, 'max_tokens') and keep the reason. In pi.ts:718, map 'length' to 'max_tokens'. Carry that stop reason into routine receipts and a UI 'Answer was cut off' chip. Optionally, have index.ts auto-continue one round when stopReason is 'max_tokens' and the turn is unattended.

### P2 Antigravity driver misclassifies its own SIGTERM/quiesce kill as a crash, and its 11-minute watchdog is a hard, unconfigurable timeout

**Location:** `server/drivers/antigravity.ts:960` (sentry-live).  **Effort:** S.

**Evidence:** Issue BOTFLEET-10 ('agy was killed by SIGKILL before result', 4 events/7d, first seen 2026-09-25) -- Sentry Seer's own root-cause: 'When forced quiesce intentionally kills an active agy child process with SIGTERM, sentry-ai.ts reports it as an unexpected crash because the SIGTERM message is absent from the isExpectedNonCrash allow-list.' Issue BOTFLEET-6 ('the agy CLI stopped responding... ending it after 11 minutes', 4 events/7d, open since 2026-09-08) -- Seer: 'a hardcoded watchdog timeout in antigravity.ts that forcibly terminates the turn.'

**Impact:** Low volume this week, but both are confirmed, still-unresolved defects: routine graceful restarts get reported as crashes (noisy/misleading telemetry), and any legitimately slow-but-working Antigravity turn over 11 minutes is killed unconditionally with no configurability.

**Fix:** Apply Sentry Seer's own identified fixes: (1) add the quiesce/SIGTERM exit path to isExpectedNonCrash so graceful shutdown doesn't page as a crash; (2) make the 11-minute agy watchdog in server/drivers/antigravity.ts configurable and/or add a warning at a soft threshold before hard-killing.

### P2 Claude CLI capability probe fails closed on newer/older CLI builds instead of validating correctly

**Location:** `server/drivers/claude.ts:575` (sentry-live).  **Effort:** S.

**Evidence:** Issue BOTFLEET-X: 'Update Claude Code to a version supporting --strict-mcp-config and refresh engines; CLI isolation support could not be verified.' (2 events, 2026-09-22, provider claudeAgent). Stack trace: server/drivers/claude.ts:575 sendTurn -> emit -> sentry-ai.ts:517. Seer: 'Make the CLI version probe check stderr and tolerate non-zero exits; add boot-time validation to surface the outdated CLI immediately.'

**Impact:** The engine-capability probe for the Claude Code CLI can falsely conclude isolation/--strict-mcp-config support is unverifiable mid-turn (user-facing failure) rather than catching a real CLI version problem at boot, where it would be actionable and non-disruptive.

**Fix:** Per Seer's suggestion: make the version probe in server/drivers/claude.ts tolerant of stderr output and non-zero exit codes when parsing capability, and run the same check at server boot so an outdated Claude Code CLI is surfaced immediately instead of failing individual turns.

### P2 Turn telemetry has no fallback attribution, and session.started overwrites the requested model

**Location:** `server/sentry-ai.ts:407` (telemetry).  **Effort:** M.

**Evidence:** sentry-ai.ts:407-413 `case "session.started": ... turn.model = event.model; turn.span.setAttribute("gen_ai.request.model", event.model);`. This replaces the requested model set at turn.started (:401-402) instead of writing gen_ai.response.model. TurnIdentity (:65-72) holds only botId, botName, instanceId, model, roomId, and roomName. The resolver at index.ts:1637-1649 fills model from `active?.selection.model ?? bot?.modelSelection.model` and does not say whether the selection came from a fallback. TelemetryTurnParams (telemetry.ts:17-41) has no stopReason, requestedModel, fallbackAttempt, fallbackReason, or transport. index.ts:2620-2640 picks a fallback (`selectTurnFallback`, `fallbackAttemptByTurn.set(fallbackKey, nextUsed)`) and never tags the turn span or the usage payload with it.

**Impact:** Sentry and Usage Monitor cannot separate a turn that ran on its first-choice engine from one that fell over after a quota or timeout. Per-engine failure rates and cost per engine are skewed, and the doomed-effort policy (5fc628cb) has no fallback data to learn from.

**Fix:** Extend TurnIdentity and TelemetryTurnParams with `requestedInstanceId`, `requestedModel`, `fallbackAttempt` (from fallbackAttemptByTurn), `fallbackReason` (the previous stopReason or quota classification), `stopReason`, and `transport` (cli, acp, http, or proxy, from the driver kind). Fill them in the index.ts:1637 resolver and in the telemetry.trackTurn call at index.ts:2697-2717. In sentry-ai.ts session.started, set `gen_ai.response.model` and keep `gen_ai.request.model`. Also set `botfleet.fallback.attempt`, `botfleet.fallback.reason`, and `botfleet.stop_reason` on the span in endTurn.

### P2 A Claude is_error result emits no runtime.error, so its reason (result text, api_error_status, subtype) never reaches errors.log, Sentry, or quota classification

**Location:** `server/drivers/claude.ts:960` (telemetry).  **Effort:** S.

**Evidence:** claude.ts:960-963 `const isError = o.is_error === true; const stopReason = isError ? (o.terminal_reason ?? o.stop_reason ?? null) : (o.stop_reason ?? o.terminal_reason ?? null);` and then only `settle(!isError, stopReason, ...)`. The handler never reads `o.subtype` (the only subtype reads are :865 and :868, both for system frames), `o.result`, or `o.api_error_status`. The BOTFLEET-K fix (fake-claude-cli.ts:224-232, claude.test.ts:230-241) now prefers terminal_reason. But when terminal_reason is absent, a failed turn still falls back to the stale `stop_reason` ("stop_sequence"), and a subtype such as `error_max_turns` or `error_during_execution` is never used as the label. index.ts:2548-2550 derives quotaOrCap from `providerErrorCodeFromStopReason(event.stopReason)` or transcript text. A 429 with duration_api_ms 0 has neither, so no cooldown is recorded. BOTFLEET-K last fired 3 days ago (18 events, claudeAgent/claude-sonnet-5).

**Impact:** A Claude failure is recorded as "bot turn failed: api_error" with no status or text. errors.log gets nothing, because it is written only on runtime.error (index.ts:2452-2466). A Claude 429 does not put the model into quota cooldown, so the next turn hits the same limit.

**Fix:** In the result case: `const ok = o.is_error !== true && (o.subtype == null \|\| o.subtype === "success"); const stopReason = ok ? (o.stop_reason ?? o.terminal_reason ?? null) : (o.terminal_reason ?? (o.subtype && o.subtype !== "success" ? o.subtype : null) ?? (typeof o.api_error_status === "number" ? `api_error_${o.api_error_status}` : null) ?? "error");`. Never fall back to stop_reason on failure. When !ok, emit `runtime.error` with `redactSecretsInText(String(o.result ?? '')).slice(0, 500)` plus the status, so errors.log, Sentry, and quota parsing all see it. Map 429 to `error:rate_limited` so providerErrorCodeFromStopReason recognises it.

### P3 computeNextOccurrence builds a new Intl.DateTimeFormat on each of up to 2,160 loop iterations

**Location:** `server/model-fallback.ts:458` (efficiency).  **Effort:** S.

**Evidence:** model-fallback.ts:458-472: `for (let offsetMinutes = 1; offsetMinutes <= 36 * 60; offsetMinutes++) { const candidate = new Date(...); const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, ... }); const parts = formatter.formatToParts(candidate); ...`. It runs from parseQuotaResetTime (:514) for every quota chip that names a zoned reset time, called at index.ts:2552 in the turn-completion fold.

**Impact:** Up to 2,160 ICU formatter constructions run synchronously on the main thread per quota failure. That is tens to hundreds of milliseconds under load, inside the completion fold that also drives fallback. It is rare but pure waste.

**Fix:** Hoist the formatter out of the loop, or compute the zone offset once and solve for the target time directly (at most two candidates, today and tomorrow).

### P3 The "request_timeout" entry in EXPECTED_TURN_STOPS never matches, because chat-completions emits "timeout"; the comment describes behavior the code does not have

**Location:** `server/sentry-ai.ts:333` (telemetry).  **Effort:** S.

**Evidence:** sentry-ai.ts:333 `const EXPECTED_TURN_STOPS = new Set(["auth_required", "cancelled", "interrupted", "request_timeout"]);` and :581-584 "\"request_timeout\" is the driver's own model-request timeout ... must not page an Issue". chat-completions/loop.ts:88 maps `request_timeout: "timeout"`, and :824 emits `stopReason: stopReasonOverride ?? STOP_REASON[exit]`. Meanwhile the matching runtime.error "the model did not answer within Ns" (loop.ts:710) is breadcrumbed as expected (sentry-ai.ts:540).

**Impact:** MiniMax, OpenAI-compatible, and Grok HTTP model timeouts page as "bot turn failed: timeout", and the only descriptive text is in a breadcrumb. The allowlist and comment suggest these are suppressed, which will mislead the next person doing triage (board bf77b434).

**Fix:** Pick one policy. Either drop "request_timeout" from the set and keep the runtime.error message as the exception (remove "the model did not answer within" from isExpectedNonCrash at :540), or match on `timeout` together with a per-turn flag set when that runtime.error arrives. Add a sentry-ai.test.ts case that drives loop.ts's real STOP_REASON value.
