# Channel Triggers and Multi-Agent Concurrency Architecture

## Executive Summary

BotFleet supports two distinct communication paradigms:
1. **Direct Bot Inboxes (1:1):** Dedicated, private working lanes between the human operator and a specialist bot (e.g.  Compiler, Fixer, Deployer, Plumber, Housekeeper).
2. **App Channels (Rooms / Multi-Agent Groups):** Shared team workspaces where one human and multiple specialist bots collaborate around a shared working directory (`cwd`), team bulletin, and common objectives.

Routing external Webhooks and scheduled Routines directly into App Channels enables team-wide visibility and cross-bot collaboration (e.g.  a build failure alert in `#Socratic.Trade` seen by both Compiler and Fixer).  However, channels risk severe token economics penalties and concurrent execution deadlocks if not governed by rigorous constraints.

This document records the architectural decisions, token bloat prevention mechanisms, ingress classification criteria, and concurrency safety rules formulated by BotFleet's token efficiency and systems concurrency deliberations.

---

## 1. Token Economics & Context Bloat Prevention

### The O(N × M) Context Multiplication Problem
In a 1:1 bot thread, an incoming webhook payload is read only by the recipient bot.  In a multi-agent App Channel with $N$ bots and $M$ subsequent turns:
- If a 40 KB GitHub check-run or Sentry stack trace is appended directly into the channel transcript, that payload is re-tokenized across **every member's subsequent turn**.
- Three bots participating in a discussion over five rounds consume $3 \times 5 \times 10{,}000 = 150{,}000$ extra tokens solely re-reading a single raw webhook event.

### The Two-Tier Architecture: Payload Vault vs. Event Capsule
To prevent runaway token consumption, BotFleet enforces a strict separation:

1. **Payload Vault (Disk Persistence):**
   - The full, raw, authenticated JSON webhook payload is written to disk under `DATA_DIR/webhooks/payloads/<deliveryId>.json`.
   - The payload remains addressable and verifiable but does not live inside the chat transcript.

2. **Event Capsule (Lean Channel Message):**
   - The message posted to the App Channel is an **Event Capsule** strictly capped at 250 tokens (~1 KB).
   - An Event Capsule contains only high-signal structured fields:
     - `Event Type`: e.g.  `workflow_job.completed`
     - `Source / Target`: Repository or service name (e.g.  `Simple-With-Us/BotFleet`)
     - `Status / Severity`: `failure` / `error`
     - `Headline`: Single-sentence summary of the failure (e.g.  `Job 'build-test' failed on branch main at commit 4a12bc8`)
     - `Payload Reference`: `delivery_id: wh_del_...`
   - Specialist bots that require full compiler diagnostics or error backtraces use an on-demand retrieval tool (`read_file` or `read_webhook_payload`) to inspect the raw vault payload in their isolated turn scratchpad without polluting the shared channel context.

3. **Sliding Compaction & Ephemeral Event Cards:**
   - Channel status events are ephemeral: when a subsequent webhook reports that a previously failing check run has succeeded, the earlier failure card is collapsed or superseded, preventing stale noise from lingering in the active context window.

---

## 2. Webhook & Trigger Ingress Classification

Not all triggers belong in an App Channel.  BotFleet enforces a strict categorization dividing events that may enter channels from those that must stay confined to private inboxes or headless execution.

### ✅ Allowed in App Channels (High-Signal Team Events)
- **Actionable Pull Request Events:** PR opened for review, PR merged to `main`, PR merge conflicts detected.
- **Continuous Integration Breaks on Shared Branches:** Failing compile, test, or lint gates on `main` or release branches.
- **Production Incidents:** Critical Sentry exceptions or PagerDuty incident alerts affecting live production services.
- **Scheduled Team Digests:** Once-daily compile health summaries or standup digests explicitly targeted to an app channel.

### 🚫 Strictly Forbidden from App Channels (Must Stay in 1:1 Inboxes or Headless)
1. **Secrets, Credentials, & Token Lifecycle Events:**
   - *Examples:* Infisical secret rotations, Cloudflare token updates, SSH key expirations.
   - *Rationale:* Multi-agent channels expose message history to multiple bots, mobile companions, and shared exports.  Credential metadata must never cross shared boundaries.
2. **High-Frequency Telemetry & Health Probes:**
   - *Examples:* 60-second `/api/health` pings, heartbeat keep-alives, metric threshold ticks.
   - *Rationale:* High frequency drowns out human discussion and burns context budgets rapidly.
3. **Workspace Janitorial Operations:**
   - *Examples:* Housekeeper disk sweeps, orphan container reclaims, cache pruning.
   - *Rationale:* Internal maintenance work has zero conversational value to team channels.
4. **Automated Metadata & Issue Churn:**
   - *Examples:* Automated sync bots (e.g.  `github-actions[bot]` updating effort logs), label changes, milestone renames.
   - *Rationale:* Creates spurious notifications without actionable development context.

---

## 3. Multi-Agent Conversation Dynamics (1 Human + 2 or More Bots)

When multiple bots reside in an App Channel, conversation dynamics must remain coherent and productive without conversational crosstalk or hallucinations.

### Sequential Intra-Channel Execution
- Concurrent bot execution **within the same channel thread is prohibited**.
- If a message or trigger summons multiple bots (e.g.  `@Compiler and @Fixer please inspect`), turns are queued sequentially in `server/room-queue.ts`.
- Bot 1 executes its turn to completion and settles its output.
- Bot 2 is dispatched only after Bot 1's turn has fully resolved, with Bot 1's final message included in Bot 2's context.

### Prior-Turn Framing
To prevent Bot 2 from repeating Bot 1's actions, Bot 2 receives a structural turn-framing annotation:
```
[PRIOR CHANNEL MEMBER TURN]
Speaker: @Compiler
Summary: Ran typecheck on branch main; identified 2 TypeScript errors in server/index.ts lines 450-455.
[/PRIOR CHANNEL MEMBER TURN]
```
This ensures Bot 2 (e.g.  Fixer) immediately understands what has already been attempted and diagnoses the issue rather than re-running the same diagnostics.

### Strict Loop Prevention (Hop Gating)
- Automated triggers in channels have a hard ceiling: `MAX_GROUP_HOPS = 1`.
- A webhook firing in a channel may trigger at most **one** automated bot turn (`hop = 0`).
- If that bot mentions a teammate (`@Fixer`), Fixer may run as a single follow-up (`hop = 1`).
- Fixer is strictly forbidden from triggering a third bot automatically (`hop >= 1` drops further auto-dispatch).
- Only an explicit human operator message resets `hop = 0`.
- Bot-to-bot infinite conversation loops are structurally impossible.

---

## 4. Systems Concurrency & Resource Safety

### Shared Computer & Container Leases
- In App Channels, multiple bots share the room's pinned working directory (`cwd`).
- For sandboxed execution:
  - **Shared VPS:** Uses per-bot isolated X displays and CUA sockets (`vpsSharedBotSession`) inside the shared container, avoiding cross-turn display collision.
  - **Local VM & Host Mac:** Strictly acquired via `ExactTurnLeases`.  If a bot requires a computer already locked by another turn, the round waits in `room-queue.ts` rather than failing destructively.

### Failure Isolation & Watchdogs
- If Bot 1 encounters an unrecoverable crash, API rate limit, or watchdog deadline timeout during its channel turn:
  1. The turn watchdog aborts Bot 1's turn cleanly.
  2. Any held computer leases or locks are immediately released.
  3. An activity error card is posted to the thread (`error: turn timed out`).
  4. The channel queue drains and proceeds to the next queued member (or returns control to the operator), ensuring the channel is never wedged.

---

## 5. Summary Matrix: Direct Inboxes vs. App Channels

| Dimension | Direct Bot Inbox (1:1) | App Channel (Multi-Agent) |
|---|---|---|
| **Participants** | 1 Human + 1 Bot | 1 Human + N Bots |
| **Working Directory** | Per-bot isolated workspace (`~/.botfleet/workspaces/<botId>`) | Pinned channel directory (`cwd`, e.g.  repo root) |
| **Webhook Payloads** | Full payload allowable if scoped to bot | Compact Event Capsule required (max 250 tokens) |
| **Secrets / Admin Hooks** | Allowed (Infisical, Plumber infra) | Strictly Forbidden |
| **Turn Dispatch** | Independent concurrent execution per bot | Linearized sequential rounds via `room-queue.ts` |
| **Max Auto Hops** | Direct turn only | Hard limit `MAX_GROUP_HOPS = 1` |
| **Default Responder** | The owning bot | Configurable (`everyone`, `member`, `mentions`) |
