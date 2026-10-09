# R4 — Token Efficiency And AI Usage (TOK)

Scope: `origin/main` d2bc60257, read-only.  Live data comes from `~/.botfleet` event, native and `messages.db` logs.  I read only usage numbers, metadata and short bot replies — no secrets, memory text or payloads.

## Where The Tokens Go (Measured)

- **Last 14 days:** 9,658 completed turns (deduplicated), about 2.22B booked input tokens.
  - dshAgent: 3,360 turns, 697M.
  - antigravityAgent: 238 turns, 1,227M.
  - mcodeAgent: 849 turns, 162M.
  - grokAgent: 895 turns, 128M.
  - minimax (the HTTP lane): 194 turns, 9.8M, 55% cached.
  - claudeAgent: 117 turns, 0.1M (115 of them failed).
    - Synthesis note: no live bot is configured on claudeAgent and `errors.log` has no claudeAgent entries, so these are likely failover or reviewer calls.  Not cross-checked.
  - Rooms: 69 turns, 8.3M.
- **Current rate:** since Oct 1, 1,495 turns and 266M tokens, about 41M a day or 178K a turn.  The Sep 25–28 peak was 357–547M a day.
- **Caveat:** for the ACP engines the booked "input" is how full the context is at the end of the turn, not what was billed (TOK-4).  Billed input is roughly that figure times the number of model calls in the turn.
- **Typical system prompt:** 24–31K characters (about 6–8K tokens).  The fixed sections (persona, computer, recall, jobs, team, credentials, routines) are about 3.7–6.3K characters.  The memory section is 18–25K characters, 76–86% of the total.
- **Prompt caching:** no clock values or IDs sit in the fixed half; the status capsule was cleaned of them.  Claude and the HTTP drivers send the fixed half first.  Codex, Pi, Antigravity and ACP paste the whole prompt into the user message.
- **Helper model calls are cheap and rare.**
  - Auto-review is opt-in, runs only on attended turns, and has an 8-second limit (`server/auto-review.ts:8`, `:36`; reviewer at `server/drivers/claude.ts:2227`).
  - Speech summaries use DeepSeek Flash (`server/tts/speech-summary.ts:28-46`).
  - I found no model call for titles or thread summaries.
- **Rooms:** one message wakes the room's default responder, plus at most one extra turn per @mention (`server/index.ts:6404-6412`, `:7870`).  Each turn gets the last 30 text messages, capped at 128 KiB (`server/turn-context.ts:93-119`).
- `docs/architecture/per-room-attention-index.md` is a UI design only; nothing in it gates wakes.

## Findings

### TOK-1 [P1] [STILL-OPEN E1, engine-audit P0, board 8b98aacd] Resumed native sessions get the whole system prompt again every turn

- **Evidence: code.**  Each engine adds the full system prompt to the turn text:
  - Codex: `server/drivers/codex.ts:304`, sent through `turn/start` (`:871`) after `thread/resume` (`:804`).
  - Pi: `server/drivers/pi.ts:932`, after `switch_session`.
  - Antigravity: `server/drivers/antigravity.ts:799`, resumed with `--conversation` (`:925`).
  - ACP core: `server/drivers/acp/core.ts:1660-1666`, after `session/load` or `session/resume` (`:1544`).
  - Eleven identical `buildPromptText` hooks: `acp/cursor.ts:493`, `droid.ts:271`, `kimi.ts:553`, `muse.ts:275`, `mcode.ts:232`, `deepseek.ts:553`, `grok.ts:347`, `dsh.ts:342`, `opencode-go.ts:385`, `hermes.ts:463`, `qwen.ts:123`.
- Only Claude splits the prompt into a fixed half and a changing half (`claude.ts:1130`).  The #883 prompt cap says it does not skip the re-send (`acp/prompt-budget.ts:5-6`).
- **Evidence: live.**  Compiler's thread `36e18dda` (mcode) logged 67 `session/prompt` calls and 63 `session/resume` calls in two hours.
  - The system-prompt part of each prompt was 17,312–20,418 characters, about 4.3–5.1K tokens.
  - The engine's reported context use (`usage_update.used`) grew from 92,506 to 770,556 out of 1,000,000.
- **Impact:** about 5K of the roughly 10K tokens the context grows each turn is a duplicate prompt.  By turn 67, up to about 320K of the 770K context is stale prompt copies.  That is an upper bound, because the engine may compact.  Every later model call re-reads them.
  - Graded P1, not P0: rollover (TOK-2) limits the growth, and provider caching probably discounts the re-reads.
- **Recommendation:** move the Claude driver's receipt scheme (`server/drivers/prompt-split.ts`) into a shared helper.  On a resumed session, send the fixed half once and the changing half only when its digest changes.  Codex might take instructions at thread start; I have not verified that.  (Effort: M)

### TOK-2 [P1] [NEW] Automation rollover counts messages, not context, so webhook threads run at 60–77% of a 1M window

- **Evidence:** a webhook thread rolls over at 300 turns or 600 messages (`server/automation-rollover.ts:41-42`, wired at `server/index.ts:5906-5914`).
  - Seven webhook threads rolled at 600–612 messages within 2–10 hours on Oct 5–6.
  - Before rolling, context use reached 770,556 (`36e18dda`) and 594,869 (`7c8ab0dd`).
  - Since Oct 1 these threads average 132K–472K input per turn.  A fresh session starts at 62K–130K.
- **Impact:** each wake pays 2–4 times the cost of a fresh session to carry old triage history.  This is the "source-thread accumulation" item from the 2026-09-24 token review, only partly fixed.
- **Recommendation:** also roll when context use passes about 150K, or start each CI webhook wake in a fresh session seeded with the last few verdicts.  (Effort: S)

### TOK-3 [P1] [NEW] About half of accepted CI wakes on the sampled thread end in "Noise — no action"

- **Evidence:** thread `36e18dda` had 68 webhook messages and 33 bot replies starting "Noise" or "Duplicate", or containing "no action".  Two examples:
  - "Noise — PR branch `ag/sync-kodus-cf-cli`, `lint` red only, no action."
  - "All three deliveries are the same run — PR #894, `lint`-only suite."
- In the attempt log's newest 1.5 hours (a snapshot, not a rate), Compiler received `check_run` 155, `workflow_run` 153 and `check_suite` 74.
- The ingress filter is a set of regexes over the trigger's own wording (`server/webhooks.ts:365-404`).
  - Nothing merges the three GitHub event types reported for one CI run.
  - Merging only happens while the bot is busy (`server/routines.ts:881`).
- **Impact:** each noise wake is a resumed turn at that thread's 472K average context.  The GitHub webhook threads are about 47% of input since Oct 1.  If this rate holds there, about 20% of fleet input goes to concluding "no action."  That is an estimate from one thread.
- **Recommendation:** add a deterministic check before waking the bot:
  - Merge `check_run`, `check_suite` and `workflow_run` events for the same (repo, head SHA, conclusion) over 10 minutes.
  - Drop checks that are not required on non-default branches when the trigger says to ignore them.
  - Record a skip receipt instead of a turn.

  (Effort: M)

### TOK-4 [P1] [STILL-OPEN E13, E14, framework-eval #6 and #7] ACP telemetry books context size as input and never output or cost, so no spend guard can fire

- **Evidence:** `server/drivers/acp/core.ts:1358-1377` sets `turnUsage.input = usage_update.used`, which is context use, not consumption.  mcode and dsh never report output, cached tokens or a nonzero cost (native log shows `"cost":{"amount":0}`).
  - Over 14 days, 2,607 dsh and mcode turns had usage, with output 0 and cached 0.
  - About 3% of turns are priced, so the spend-ceiling check (`spendCeilingDecision`) returns "not enforced": the minimum priced share is 0.5 (`server/rolling-spend.ts:514`, `:556-560`).  Any configured ceiling is unenforceable on this fleet.
  - No per-turn token or round cap applies to the CLI and ACP engines.
- **Past spikes:** Monitor's Antigravity turns booked 60.4M and 68.4M input in single turns on Sep 26–27.  Daily input hit 547M on Sep 26.
- **Impact:** the runaway-cost guard is blind to about 97% of turns, and billed input per model call is unknown, so no saving can be verified.
- **Recommendation:**
  - Record per turn: context use at start and end, the number of model calls, and the result's own usage when present.
  - Add a token-based 5-hour ceiling for unattended work.
  - Add a per-turn token or call cap for the CLI and ACP engines.

  (Effort: M)

### TOK-5 [P2] [NEW] MEMORY.md is 76–86% of every system prompt, and its "trim it" note costs whole wake turns

- **Evidence:** in the latest prompt of five bots the memory section is 18–25K of 24–31K characters (Deployer 25.5K of 31.4K, Fixer 22.0K of 25.6K, Compiler 18.4K of 24.1K).
  - The cap is 200 lines or 24,000 bytes (`server/workspace.ts:21-22`).
  - A "[MEMORY.md exceeds the … budget … — trim it.]" note is added every turn (`:172-175`).  It is present for Deployer, Compiler and Director.
  - Compiler on CI wakes: "Exactly 200 — so the last line is being cut mid-render.  Trimming…" and "the truncation warning on my memory file persists."
  - The memory guidance says the file is shown "at the start of every session" (`:168`), but ACP engines get it every turn (TOK-1).
- **Impact:** about 4.5–6K tokens per prompt, multiplied by TOK-1, plus turns spent tidying memory during unrelated alerts.
- **Recommendation:** cap the inlined memory at about 6 KB (the head plus a topic index), deliver the trim request once per change through the receipt, and leave the rest to `read_file`.  (Effort: S)

### TOK-6 [P2] [NEW] The cheaper-model switch for unattended turns skips the engines that run the fleet

- **Evidence:** `unattendedModelDowngrade` only switches models for the `claudeAgent`, `antigravityAgent` and Gemini families (`server/model-fallback.ts:153-176`).  The only other move is a webhook-only switch off mcode's thinking Flash (`:132-145`).
  - Deployer, Designer, Fixer and Builder run `grok-4.7` on grokAgent.
  - Oracle and EngineProbe run on dsh (from bots.json).
  - Their webhook and resource wakes keep the same model and effort.
  - Scheduled routines are excluded by design (`:120-123`).
- **Impact:** 895 grokAgent and 3,360 dshAgent turns in 14 days got no unattended discount.
- **Recommendation:** an opt-in, per-engine unattended map (for example DSH Pro to Flash, grok at low effort), judged by outcomes rather than list price.  (Effort: S)

### TOK-7 [P2] [NEW] Every ACP wake mounts five tool servers, including two computers and duplicate recall tools

- **Evidence:** `session/new` on `36e18dda` mounted five tool servers (MCP): `agents`, `composio`, `computer_host`, `computer_shared_vm` and `qdrant`.
  - Each computer server has 16 tools (`server/computer-proxy.ts:462-650`).
  - The qdrant server has 7 tools.  `qdrant_search`, `qdrant_get_context` and `qdrant_store` duplicate `recall_search` and `recall_contribute` (`server/drivers/qdrant-proxy.ts:72-180`).
  - The agents server, measured through `mcpToolDefinitions`, is 11 tools and 10,982 bytes.  About 5.9 KB of that is routine-proposal schemas sent on every CI wake.
  - The first context reading on three webhook threads was 62K–130K tokens.
- **Impact:** thousands of tool-definition tokens are re-read on every model call of every wake, and recall is split across two tool names.  How the 62–130K baseline divides between the CLI's built-ins and BotFleet's servers is not measured.
- **Recommendation:** drop the `qdrant_*` aliases, mount one computer chosen by the trigger, and leave routine and create-bot tools off webhook wakes.  (Effort: S)

### TOK-8 [P2] [STILL-OPEN A2, partly] Bots with section peers are told to forward alerts to the owner's named specialists

- **Evidence:** `server/index.ts:5349` says: "Never dismiss incoming alerts … by merely claiming 'not my problem'… (e.g. Compiler…, Deployer…, Fixer…, Plumber…, Housekeeper…, Builder…) and forward the alert… using delegate_bot (preferred)".
  - It ships to every user's bots that have section peers.
  - It cuts against the persona rule "post only what another person needs in order to act" (`:5065`).
  - Compiler: "That's my second Deployer handoff."
- **Impact:** it pushes a second full wake on another bot for alerts the first bot could close as noise, and it names bots other users may not have.  I could not measure how often forwarding happens: `delegations.json` is empty.
- **Recommendation:** build the examples from the live roster, and add: "If it is noise, say so in one line and stop; forward only when a named teammate must act."  (Effort: S)

### TOK-9 [P2] [STILL-OPEN framework-eval #5] There is no per-bot wake budget; each webhook endpoint allows 14,400 wakes a day

- **Evidence:**
  - The only intake limit is 10 requests per 60 seconds per endpoint (`server/webhooks.ts:169-170`, `:1245-1246`).
  - Compiler's home thread ran 873 turns on Sep 23 and 740 on Sep 24.
  - `server/` has no wake budget or unattended concurrency cap.
- **Impact:** a CI storm becomes a model-call storm, with only TOK-4's blind dollar ceiling behind it.
- **Recommendation:** a per-bot token bucket for unattended wakes (for example 20 an hour, bursts of 5) that folds the overflow into the next wake.  (Effort: S)

### TOK-10 [P3] [STILL-OPEN T12, DR11] HTTP tool definitions grew to 40 tools and 24 KB

- **Evidence:** with every gate on, the HTTP catalog is 40 tools and 24,128 bytes; it was 35 tools and 20,725 bytes on Sep 27.  A typical bot gets 17 tools and 15,557 bytes.  `propose_routine_action` is 3,011 bytes and `propose_routine` is 2,851 (`server/tools/registry.ts:463-494`, `:1355`).
- **Impact:** small.  The HTTP lane is 0.4% of input and already caches 55%.  There is no direct Anthropic API path where `cache_control` would help (0 matches in `server/` and `shared/`).
- **Recommendation:** offer the routine tools only when routines come up, and put the `github_*` tools behind one tool.  (Effort: S)

### TOK-11 [P3] [STILL-OPEN E18] The HTTP replay window still slides by one entry every turn

- **Evidence:** the 128 KiB cap (`server/turn-context.ts:53`) and the 200 KiB / 60-entry cap (`server/drivers/chat-completions/replay-cap.ts`, `DEFAULT_REPLAY_CAP`) are recomputed from the newest end each time.  The cut point never holds steady.
- **Impact:** long HTTP-lane threads keep losing their cached prefix, but the lane is a tiny share of tokens.
- **Recommendation:** trim in coarse steps and persist the start point.  (Effort: S)

### TOK-12 [P3] [STILL-OPEN G23] Claude's warm session is reused for room turns and fed the whole 30-message block again

- **Evidence:** the warm process is reused when `(!sessionId || sessionId === live.sessionId)` (`server/drivers/claude.ts:1259`).  Room turns pass no session cursor and send the full room context (`server/index.ts:6411`, `:7423`, `:7763-7770`).
- **Impact:** close to zero today: rooms are 0.4% of tokens, and 115 of 117 claudeAgent turns failed before any usage.
- **Recommendation:** send only the new lines to a warm room session, or force a fresh one.  (Effort: S)

### TOK-13 [P3] [NEW] Room skill and playbook selection reads the whole 30-message context

- **Evidence:** skills are chosen with `selectBundledSkills(serializeRoomContext(...))` (`server/index.ts:7254-7256`).  Playbooks are chosen with `installedPlaybookInstructions(text, …)`, where `text` is the serialized room context (`:7423`, `:7638`).  The 1:1 lane selects from the current message only.
- **Impact:** a trigger word anywhere in the last 30 messages keeps skill instructions in every room prompt.
- **Recommendation:** select from the newest message.  (Effort: S)

### TOK-14 [P3] [STILL-OPEN A6] The room prompt still leaves out the connected-apps sentence

- **Evidence:** the direct lane has a `composio` section (`server/index.ts:5466-5474`).  The room prompt (`:7609-7640`) has none, even though rooms mount composio.
- **Impact:** room bots hold tools they are never pointed at.
- **Recommendation:** one shared prompt builder for both lanes.  (Effort: M)

### TOK-15 [P3] [NEW] `channel-triggers-and-concurrency.md` describes token controls that do not exist

- **Evidence:** the doc says BotFleet "enforces" these, but none appear anywhere in `server/`, `shared/` or `src/`:
  - A Payload Vault for raw webhook data.
  - A 250-token Event Capsule.
  - A `read_webhook_payload` tool.
  - `[PRIOR CHANNEL MEMBER TURN]` framing.

  The doc cites them at `docs/architecture/channel-triggers-and-concurrency.md:22-37`, `:83-86`.  Webhooks have no room target.
- The real 1:1 path pastes the slimmed payload into the prompt (`server/webhooks.ts:961-1000`): 2.7–22K characters per Compiler prompt.
- **Impact:** readers will assume a payload limit and room isolation that the code lacks.
- **Recommendation:** mark the doc as a proposal, or build the vault and capsule for 1:1 wakes.  (Effort: S)

## Course Corrections

1. **Send the prompt once per native session (TOK-1, TOK-5).**
   - Long-lived automation threads would shed about 30–40% of per-turn context.  At the current ~41M a day that is about 12–16M tokens a day, before multiplying by model calls per turn (an estimate).
   - Measure with the slope of `usage_update.used` per turn in the native logs, which is already recorded.  The target is the payload plus the reply (about 3–5K tokens), not about 10K.
2. **Treat a CI wake as a small fresh session, not another entry in a 600-message thread (TOK-2, TOK-7).**
   - The baseline of 62–130K tokens against today's 132–472K averages cuts webhook-wake input by 50–75%.
   - Measure the average input per turn on the "Compile gates" and "GitHub Merge Conflicts" threads.
3. **Decide "noise" before the model does (TOK-3, TOK-8, TOK-9).**
   - Deduplicating CI runs and adding a per-bot wake budget would remove an estimated 15–20% of fleet input.
   - Measure the share of accepted wakes whose reply starts "Noise" or "Duplicate", which should fall toward zero, plus a new skip receipt count.
4. **Budget in tokens, not dollars (TOK-4).**
   - A dollar ceiling cannot work while 97% of turns are unpriced.
   - Record per-turn start and end context use and the number of model calls; set a token ceiling and a per-turn cap.  That turns the Sep 26–28 spikes (60–68M tokens in one turn, 547M in one day) into blocked runs.
5. **Stop putting HTTP-lane work first (TOK-10, TOK-11).**
   - The framework evaluation's top fix (`cache_control`) and schema trimming target 0.4% of input.
   - Spend the effort on the native-session engines, which account for over 99% of booked input since Oct 1.

## Fixed Since Prior Audits

| Prior id | Evidence |
|---|---|
| DR1: busy state in the Chief of Staff roster | The roster now omits it (`server/chief-of-staff.ts:33-46`).  The status capsule no longer prints the observation time, receipt hash or ready count (`server/botfleet-status-capsule.ts:351-364`). |
| DR5: `read_file` returned the whole file | 400-line default and a byte cap (`server/tools/computer.ts:34-41`, `:220-232`). |
| DR8: Antigravity dropped cached input | Now recorded (`server/drivers/antigravity.ts:1299-1306`); live data shows 89.3% cached. |
| A2: owner's private fleet protocol in every bot's prompt (partly) | The persona is now plain `You are ${bot.name}` (`server/index.ts:5061-5068`).  The fleet text needs `BOTFLEET_FLEET_SEAT_PROMPTS=1` (`server/seat-prompt.ts:103-105`).  The named specialists remain (TOK-8). |
| 09-24 token review: history replayed without a byte cap | Fixed by `boundNativeTranscript` and `boundRoomContextLines` (`server/turn-context.ts:53-119`). |
| C13: no prompt size limit (partly) | ACP now has a 128 KiB per-turn cap (#883, `server/drivers/acp/prompt-budget.ts`). |
