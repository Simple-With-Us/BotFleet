# BotFleet Agent Framework Evaluation

Author: MiniMax (`[MINIMAX]`).  Date: Sun, Sep 27, 2026.  Scope: the runtime
that lives behind every BotFleet bot — bots, channels/rooms, threads, the
trigger layer, context assembly, and the tool/plugin surface.  Every structural
claim below is cited to `file:line` and was read from `origin/main` at
`532ce508b`.  Nothing here is a measurement; where a number would require
running the fleet, that is stated rather than estimated.

**Diagram:** [`2026-09-29-agent-framework-diagram.html`](2026-09-29-agent-framework-diagram.html)
— open it in any browser; it is a single self-contained file.

## Verdict In One Paragraph

BotFleet has an unusually strong **trigger layer** and a surprisingly weak
**context layer**.  The work that keeps a fleet from melting down — coalescing a
webhook storm, refusing to redispatch a dead engine, protecting an idle harness
from a 35 MB save, spending only on unattended work — is done well and is
better than what xAI publicly documents for Grok Bot.  The work that decides
what the model actually pays for is largely absent: there is **no compaction
anywhere**, **no explicit prompt-cache directive anywhere**, **no semantic tool
selection**, and **no systemic cap on tool output**.  The gap is not that the
design is wrong; it is that the cost-control surface was never built, while the
reliability surface was.  Seven clear wins below are small and high-yield.  The
one that actually moves the needle on token spend — compaction — is a genuine
judgment call, and I have deliberately left it in the options section rather
than pretending it is obvious.

## 1. What The Framework Actually Is

The object model in code is:

```
Bot  ──1:n──▶ Task/Thread ──1:n──▶ Message (parentId chain, branchable)
  │                  │
  │                  └── assigned to exactly one bot at a time
  ├── grants        (computers, recall, phone, github, linq, composio, chiefOfStaff)
  ├── modelSelection (engine + model + effort)
  └── Routine / Webhook / ResourceTrigger ──▶ produces a RoutineRun
Room  ──1:n──▶ Message  (many bots, shared context, per-thread serialized)
```

Two structural properties matter for everything downstream.

**The Bot is the unit of work, and it is a single-writer resource.**  Admission
is a single boolean, `server/index.ts:3728`:

```ts
if (bot.busy) throw Object.assign(new Error("the bot is already working — interrupt it first"), { status: 409 });
```

and every trigger path respects it at `server/routines.ts:974-982`, where a busy
bot's runs simply stay `queued`.  This is a clean invariant and it is enforced
in exactly one place.  Keep it.

**The thread is the unit of context, and it is deliberately unbounded.**  There
is no thread-level rollup, no archive, and no summary.  The design answer to
"the conversation is getting long" is *stop starting new ones* — a four-tier
thread-resolution fallback at `server/routines.ts:1021-1051` reuses the task
stamped with the automation key, then the last run with the same key, then the
bot's live thread, and only then mints a new task.  That is a good answer to a
UX problem.  It is not an answer to a token problem, and it is why the token
problem exists.

## 2. Trigger Layer — The Strong Part

Every way work enters the system, and whether it is safe:

| Entry | Auth | Idempotent | Site |
|---|---|---|---|
| Webhook `:8800/hooks/{id}/{secret}` | capability secret or Bearer, checked **before** body read | yes — `endpointId:deliveryId` | `webhook-ingress.ts:204`, `webhooks.ts:1177` |
| Linq webhook | HMAC `X-Linq-Signature`, before admission | via same path | `index.ts:4819` |
| Schedule | local scheduler, 10 s tick | missed-run marker >12 h | `routines.ts:907` |
| Resource trigger | local sampler, 30 s tick | cooldown + streak only | `resource-triggers.ts:469` |
| Manual run | 8799 loopback + origin gate | receipt replay | `routines.ts:750` |
| Steer | 8799 gate | **memory-only, not persisted** | `steer-queue.ts:52` |
| Inbound iMessage | relay identity + idempotency cache | yes, + echo breaker | `index.ts:10659` |
| Delegation | `authorizedComms` + per-turn grants | capped 4/thread, not deduped | `delegations.ts:112` |
| Boot resume | claims set | yes | `index.ts:5720` |

Four mechanisms are genuinely well-judged, and each was clearly built from a
real incident rather than from a design doc.

**Dedupe is checked before the rate limit, and flushed durably before the 202.**
`webhooks.ts:1229-1238` — the comment says a retrying sender must stay idempotent
even while the queue is full, so only new work consumes a slot.  And
`webhooks.ts:1266-1272` forces a synchronous save of the dedupe record before
acknowledging, because a debounced flush plus a restart would forget it and the
sender's retry would become a second real run.  This is the kind of thing that
is usually wrong.

**Trigger gaps coalesce instead of dropping.**  `routines.ts:988-996`.  An
uptime monitor that fires every 90 s used to produce a hundred one-message
conversations; now the deliveries wait and fold into a single turn, which is
both cheaper and a better prompt ("these six checks failed" rather than six
copies of "a check failed").  The fold is capped at 64 000 chars for a
specific, remembered reason (`trigger-gap.ts:75-78`): an unbounded batch is what
previously produced a 700 KB prompt that timed out one engine and then failed
another.

**Doomed-dispatch is a half-open breaker on `(bot, engine)`.**
`doomed-dispatch.ts`.  The file header records the measurement that motivated
it: of 2 001 runs over three days, 216 were `spawn_error` and 105 `rpc_error`,
so 86 % of failures were the process never starting.  A recurring trigger firing
on a timer cannot fix a CLI that is missing or waiting on an interactive login.
Critically, the refusal **leaves the run queued rather than failed**
(`index.ts:4526-4535`), so it still lands once the breaker half-opens.

**Backpressure is layered, and the ordering is deliberate.**  256 KB body cap →
per-endpoint 10/60 s rate limit → per-endpoint 3 pending runs → 3 ignored or 10
rejected attempts mutes the endpoint → bot-busy holds the run.  A burst of 50
webhooks therefore costs one turn, not 50.

**Spend is gated only where nobody is watching.**  `index.ts:756-764` is the
best-designed line in the codebase:

```ts
function spendBlockedForUnattendedWork(runOn: RoutineRunOn): boolean {
  if (runOn !== "bot") return false;
  const decision = spendCeilingDecision(rollingSpendTracker.getWindow(), { ... });
  if (decision.blocked) console.warn(`[spend] refusing unattended work: ${decision.reason}`);
  return decision.blocked;
}
```

A cap that can stop background automation without silently refusing a message
the owner is waiting on.  The companion detail is just as good: it also refuses
to fire when too little of the window is priced to trust the total, because "an
unattended fleet that silently stops working is a worse outcome than one that
overspends."

### Trigger-layer gaps

1. **No priority among queued runs.**  `routines.ts:974` iterates
   `[...this.runs].reverse()` — newest first — then marks older ones
   coalesced.  A human "run this now" and a routine that fired 30 s ago compete
   on arrival recency alone.
2. **Head-of-line blocking is structural.**  One long turn delays every queued
   run for that bot, and the worst case is a full 10 s tick plus the blocking
   turn.  There is no preemption, no aging, and no parallel lane per bot.
3. **No global concurrency ceiling for unattended work.**  Concurrency is
   exactly N bots.  Boot recovery is the only place with a numeric cap
   (`BOOT_RESUME_CONCURRENCY = 3`).  Twelve bots all crossing a resource
   threshold in the same 30 s sample = twelve concurrent model calls.
4. **Resource triggers are not dedupable.**  Every fire mints a fresh UUID;
   repeat suppression is cooldown and streak only.
5. **Steer entries are memory-only.**  A restart mid-turn loses them.
6. **The NLP ignore-prefilter is an unreviewed silent-drop path.**
   `webhooks.ts:1-1140` is a large regex engine deciding whether to drop an
   event *before* dispatch, on the only internet-reachable listener.  Nobody has
   characterized its false-positive rate.  This deserves its own review.

## 3. Context Layer — The Weak Part

### 3.1 What is in a turn

`buildSystemPrompt` (`system-prompt.ts:83-99`) takes ordered parts, measures
UTF-8 bytes per section, and splits stable from volatile.  Volatile membership
is a fixed id set — `memory`, `mentions`, `outstanding`, `recent`,
`skill-instructions`, `playbooks`, `automation` (`system-prompt.ts:65-73`).

| Layer | Cap | Site |
|---|---|---|
| persona, voice, computer, composio, recall, coordination, credential, routine, section-context, owner-notes | **unbounded** | `index.ts:4162-4235` |
| memory | 200 lines / 24 000 B | `workspace.ts:21` |
| skills index | 15 skills / 16 000 B | `skills.ts:42` |
| skill-instructions (full bodies) | **unbounded** | `skill-library.ts:132` |
| playbooks | 3 / 24 000 chars | `installed-playbooks.ts:3` |
| tool schemas (sibling field, not in prompt) | see below | `index.ts:4253` |

Six layers have no ceiling at all.  Three of them are owner-authored text
(persona, owner-notes, section-context) and one is the concatenated body of every
matched skill.

### 3.2 History selection — a fixed 40-message tail

`index.ts:3890`:

```ts
const transcript = activeMessages
  .filter((m) => m.kind === "text" && m.text && !skipTranscript.has(m.id))
  .slice(-40)
  .map(...)
```

`activePath` walks the parent chain from the active leaf, so abandoned forks
structurally cannot reach the model — that part is right.  The 40 is then
byte-bounded twice more (128 KB native at `turn-context.ts:47`, and
200 KB / 60 entries for replayed transcripts at `chat-completions/replay-cap.ts`),
and room turns use a 30-message block instead (`index.ts:4940`).

### 3.3 Compaction: none

I grepped `compact|compaction|summariz|truncat` across `server/`, `shared/`,
`src/`, and `docs/` — 229 hits in 57 files, and every one is a UI function, a
notification helper, or a per-file byte cap.  **There is no history
summarization, no compaction, and no pruning of conversation history anywhere
in the system.**  Every mechanism that exists is a hard cut.

The consequence is specific rather than abstract: a trigger that reuses the
primary thread — which is the default, and the encouraged behavior — keeps
paying for the last 40 messages of its own accumulated history on every single
wake, forever.  The design that fixed the UX problem made the token problem
permanent.

### 3.4 Caching: engineered, then not requested

This is the single most surprising finding.  The harness *deliberately* splits
the prompt into a byte-identical stable prefix and a volatile tail
(`system-prompt.ts:17-19`: "the bytes a provider's cached prefix, or a spawned
CLI's session contract, must keep identical"), routes the stable half into the
`system` message and the volatile half onto the newest user message
(`prompt-split.ts:90-94`), and depends on the loop appending rather than
rewriting (`loop.ts:846-849`).  The Claude driver even fingerprints the spawn
contract so a memory edit does not respawn the CLI.

**And then `grep -rn "cache_control" server/ shared/ src/` returns zero
hits.**  Every one of those bytes is being re-priced at full input rate on every
round, on providers that would have discounted the prefix for the asking.  The
harness is instrumented for this — `telemetry.ts:41-47` documents `promptBytes`
as "read against `cachedInputTokens` to see whether the prefix is actually being
cached" — but it never asks.

Codex and the ACP lane make it worse: they interpolate the whole prompt into one
user message (`acp/core.ts:1447`), so they get no prefix stability at all, and a
memory write re-prices the entire prompt.

### 3.5 Accounting

Provider-reported only; there is no tokenizer in the repo and no dependency on
one.  Usage is extracted per round (`chat-completions/usage.ts:4-10`), summed
(`usage.ts:13-22`), and emitted once per turn with `in = input - cached`,
`cache = cacheRead`, `out = output` (`telemetry.ts:400-404`).  The telemetry
event carries `botId`, `threadId`, `modelId`, `driverKind`, `latencyMs`, and
`promptBytes` (`telemetry.ts:17-48`), so per-bot and per-turn attribution exists
in the remote Usage Monitor.  Per-round usage is summed and discarded, and there
is no local token-usage endpoint (`/api/tts/usage` is unrelated), so
post-hoc round-level attribution is impossible.

## 4. Tool And Plugin Layer

### 4.1 The discipline is real

`server/tools/registry.ts` is one array, one `gate` predicate, two renderers.
Its header explains why: a tool used to exist three times (MCP `inputSchema`,
chat-completions `parameters`, endpoint body) and drifted.  Wire deviations
between the two lanes are *declared* (`ToolWireDeviation`, `registry.ts:124`)
rather than silently tolerated.  The one live deviation — `ask_bot` renames
`message`→`task` on HTTP for transcript compatibility — is a good example of
the mechanism being used for its actual purpose.

The selection is a pure filter over a static array:

```ts
export function toolsFor(surface: ToolSurface, ctx: ToolGateContext): HarnessTool[] {
  return HARNESS_TOOLS.filter((tool) => tool.surfaces[surface] && tool.gate(ctx));
}
```

### 4.2 No semantic tool selection exists

36 tools in the registry.  Gating is by per-bot grant booleans and driver
capability, both effectively static for the life of a turn.  There is no
scoring, no embedding lookup, no top-k, and no task-similarity term anywhere in
`registry.ts`.  A fully-granted bot on an HTTP driver is offered all 36 schemas
on every turn — including ten `github_*` tools when the task is "write me a
haiku."  Measured by bundling the registry and calling `httpToolDefinitions`, the
full set is ~22 KB of schema (~5.5 K tokens at 4 B/token); the agents subset is
~8.7 KB.  Two routine-proposal schemas alone account for 27 % of the total.

The only message-content-sensitive selection in the entire subsystem is the
bundled-skill selector (`skill-library.ts:118-130`), and it selects **prompt
text, not tools**:

```ts
return skills.filter(({ manifest }) =>
  manifest.defaultEnabled &&
  manifest.requiredCapabilities.every((capability) => available.has(capability)) &&
  manifest.triggerTerms.some((term) => haystack.includes(term.toLowerCase())));
```

A literal lowercase `String.includes`.  In the current tree the only capability
ever passed is `["phoneMcp"]`, so this heuristic can presently select phone
skills and nothing else.

### 4.3 Composio is the unbounded surface

Third-party `tools/list` is relayed live and verbatim with no cap and no
name-prefixing (`connector-proxy.ts:99-116`).  Harness-side controls are a
post-hoc list filter that **fails open** by design — "the hard boundary is the
tools/call verdict above, not this listing" (`index.ts:8514-8518`) — plus a
per-call grant check.  The grant logic is strong: `evaluateConnectorTools`
(`connector-verdict.ts:155-174`) treats an unparseable call as `unrecognized`
and refuses it, because "a call whose target tools cannot be read is a call
whose tools cannot be checked," and it holds "even against a model that garbles
the protocol."  That is the right instinct.  The exposure is that the schema
volume a third party can inject into every turn is unbounded, and the
fail-closed execution path does nothing to reduce prompt bytes.

### 4.4 Two lanes, never merged — and no collision policy

`httpOnlyToolSurface` picks exactly one lane per turn.  The MCP mount path
pushes five named stdio servers into one array (`acp/core.ts:81-139`).  The
`agents` server publishes 8 registry names with no prefix, and a Composio tool
of the same name would collide at the engine's discretion.  There is no
namespacing policy in the harness; `MCP_TOOL_ORDER` is a hand-maintained string
duplicate of a registry subset that throws at module load if the registry drifts
(`agents-proxy.ts:80-82`).

### 4.5 Result bounding is per-tool, not systemic

`loop.ts:872` appends the host's return value verbatim:

```ts
messages.push({ role: "tool", tool_call_id: calls[i].id, content: outcomes[i].content });
```

`TurnToolOutcome` has no length field.  `read_file` is capped at 64 KB and 400
lines; `recall_search` clamps to 1..20; Composio relays cap at 20 MB.  **`bash`
has no byte cap at all** — only the 90 s per-tool clock.  With a 40-round
default budget, that is the one unbounded growth path in the context pipeline.

### 4.6 The round budget does not apply where the money is

`DEFAULT_MAX_TOOL_ROUNDS = 40` (`shared/bot-profile.ts:22`, raised from 12
after a real incident — "a compile gate, an incident investigation, or a
multi-repo change routinely needs more than twelve model→tool hops"), enforced
at `loop.ts:636`.  The model is told the number up front (`toolBudgetPrompt`)
specifically so a hard stop lands as a plan rather than a surprise.  That is
good design.  But **this budget is the HTTP chat-completions lane only** —
Claude, Codex, Grok, and the ACP engines run their own agent loop inside the
vendor process, and the harness's `maxRounds` does not bound them at all.

## 5. Comparison

### 5.1 Versus Grok Bot

Grok Bot (xAI, launched 2026-08-11) and BotFleet are close cousins, and the
public design post is explicit that "the main objects in Grok Bot are Bots, not
conversations" — which BotFleet already believes.  Divergences that matter:

| Dimension | BotFleet | Grok Bot | Edge |
|---|---|---|---|
| Primary object | Bot, with a branchable thread | Bot, with a chat | parity |
| Trigger generality | arbitrary webhooks + host-resource thresholds | fixed event list (Slack, Git, Linear, Sentry, PagerDuty, webhooks); no email, no calendar at launch | **BotFleet** |
| Trigger coalescing | trigger-gap folds a storm into one turn | not publicly documented | **BotFleet** |
| Dead-engine suppression | doomed-dispatch half-open breaker | not publicly documented | **BotFleet** |
| Cost guard | rolling 5 h ceiling, unattended only | not publicly documented | **BotFleet** |
| Multi-hop delegation | `MAX_COMMS_DEPTH = 1` — a depth-1 ceiling | bots message and trigger each other; Chief routes to specialists | **Grok Bot** |
| Cross-bot routing | model picks by tool name from a flat list | routes by matching the *description* of another agent | **Grok Bot** |
| Skill acquisition | markdown import, or bundled + triggerTerms | teach by demonstration — record once, get a skill | **Grok Bot** |
| Approval | per-tool policy `ask`/`allow-once`, verdict broker, fail-closed at execution | natural-language rules + a separate reviewer agent + allow/block lists | **BotFleet** (more precise) |
| Runtime isolation | per-bot computer *grants*, one shared harness process | a persistent cloud computer per bot | **Grok Bot** |
| Tool / skill scope | per-bot grants, per-bot skills | account-level tools and skills; per-bot memory and routines | parity |
| Context compaction | none | none documented | tie — a shared blind spot |

The honest summary: **BotFleet wins the reliability layer and Grok Bot wins the
authoring and orchestration ergonomics.**  BotFleet's depth on cost control and
failure suppression is not incidental — it is the product of having run real
triggers in production.  What BotFleet lacks is the cheap UX that makes humans
*want* to set up deep automation: demonstration-captured skills, description-
based routing, and real multi-hop delegation.

### 5.2 Versus the rest

- **Claude Code / Codex** — strong orchestrator-and-subagent loops with a real
  per-agent budget.  BotFleet's equivalent is a depth-1 `ask_bot`, which cannot
  express the pattern both vendors are built around.
- **OpenClaw / Hermes** — multi-gateway routing (Telegram, Discord, Slack,
  WhatsApp, web) with shared memory across gateways.  BotFleet has a strong
  webhook ingress and a native iMessage relay, but no notion of a gateway that
  maps several transports onto shared memory.
- **Cursor** — the substrate Grok Bot runs on, and it inherits Cursor's MCP,
  plugin, and skill compatibility.  BotFleet has ACP drivers rather than MCP-only
  tool exposure, which is a genuine architectural difference (BotFleet can hand
  a vendor CLI a *session contract*, not just tools).

## 6. Clear Wins

Ranked by yield per unit of risk.  Complexity is 1 (hours) to 5 (a project).

| # | Win | Complexity | Why it is not a judgment call |
|---|---|---|---|
| 1 | **Send `cache_control` on the stable prefix** for providers that support it | **1** | The split, the ordering, and the telemetry already exist.  The harness computes `stable` and `volatile` and then never asks for the discount.  This is a missing flag, not a design decision. |
| 2 | **Cap tool output in the loop, not per-tool** | **1** | `loop.ts:872` takes whatever the host returns.  One truncation helper with a byte budget and a truncation marker removes the only unbounded path in the pipeline; `bash` is the proof that per-tool caps leak. |
| 3 | **Global concurrency ceiling for unattended work** | **2** | Concurrency is currently exactly N bots, with the sole numeric cap reserved for boot resume.  A resource-trigger storm turns that into N simultaneous model calls by design. |
| 4 | **Cache the tool-schema array per gate shape** | **2** | `httpToolDefinitions` rebuilds the JSON on every turn to produce a value that depends on a handful of booleans.  A memo keyed on the gate signature is mechanical. |
| 5 | **A per-bot wake token bucket** | **2** | Six separate volume guards exist and none of them is a rate on wakes per bot.  The 5-hour spend ceiling is a consequence filter, not a rate limiter — it stops you *after* the spend. |
| 6 | **Apply a per-turn cap to the CLI/ACP lanes too** | **2** | The 40-round budget — the thing the model is explicitly told about — does not apply to the engines that actually run the fleet's long work. |
| 7 | **Emit per-round usage instead of summing and discarding** | **2** | Without it, the cost of the 40th round is unattributable and no optimization of this document can be verified after the fact.  This is the instrumentation that makes every other win measurable. |

Each of these is additive, low-risk, and independently testable.  None changes a
behavior a user can observe except #3 and #5, which only *bound* work that is
currently unbounded.

## 7. Options Worth Considering

Not clear-cut.  Each has a real cost and a real argument against.

### 7.1 Context compaction — the big one

This is the change with the largest token impact, and the one I am least willing
to call obvious, because the current design has an argument in its favor: a
summary is lossy, and a bot that has been running unattended for a week may
depend on exact details of what it was told.  Options:

- **(a) Sliding window plus a rolling summary.**  Classic.  Replace the oldest
  of the 40 with a maintained digest.  *For:* bounded cost regardless of age.
  *Against:* summary drift, and you now have two sources of truth for the same
  turn.
- **(b) Turn-token-budgeted selection,** keeping the newest N *and* any turns
  the bot explicitly pinned.  *For:* no lossy text; the bot controls what
  survives.  *Against:* requires a pinning concept the data model does not have.
- **(c) Store a summary beside the history, use history normally, and use the
  summary only on a cold start or a fresh engine.**  This is the lowest-risk
  variant and is the one I would build first: it can only help the case that is
  currently worst (a trigger waking into a long thread), and it changes nothing
  about a normal working turn.
- **(d) Do nothing, and instead make thread reuse token-aware** — e.g. a trigger
  whose own prior turns dominate the window resets to a fresh task.  Cheapest,
  and it attacks the actual worst case rather than the general one.

My recommendation is **(c) first, (b) second, never (a) as a first move.**  A
lossy summary is a behavior change to unattended work; an additive cold-start
summary is not.

### 7.2 Progressive tool disclosure

- **Top-k by embedding** against the incoming message.  Effective, but adds a
  model call or an embedding step to every turn, and tool selection is currently
  *free*.
- **Two-tier: names always, schemas on demand.**  Ship a compact index (name +
  one line) and let the model fetch a schema when it wants a tool.  The registry
  already makes this cheap — `descriptionFor` and `schemaFor` are separate
  accessors at `registry.ts:1195-1202`.  This is my favorite of the three
  because it reuses machinery that already exists.
- **Skill-scoped grants.**  A bundled skill's presence narrows the tool set.
  Cleanest semantics, but it couples tool availability to skill selection, and
  skill selection is currently a substring match.

### 7.3 Multi-hop delegation

`MAX_COMMS_DEPTH = 1` is a deliberate, well-chosen default — it makes the whole
comms surface a bounded cost.  Raising it is what would let BotFleet express the
Chief-and-specialists pattern Grok Bot ships.  The cost is a genuine fan-out
risk, and the `drainingsThreads` reentrancy guard plus the 4-per-thread cap are
the only things bounding it today.  I would not raise the cap before #3 and #5
exist.

### 7.4 Description-based routing for `ask_bot`

Grok Bot routes by matching a task against *other agents' descriptions*.  This
is cheap, needs no new infrastructure, and fits BotFleet's `chiefOfStaff` flag
which is currently the only routing signal.  A third option is a real scheduler
mapping intent to a named bot, at the cost of a taxonomy to maintain.

### 7.5 Teach-by-demonstration

Grok Bot records a human performing a task once and emits a skill.  For BotFleet
this is a real differentiator against a product you already pay for, and the
`skills` import path already exists.  The hard part is not capture, it is
trusting the derived skill — which is an approval-surface problem, not an ML one.

### 7.6 Per-bot runtime isolation

Grok Bot gives every bot its own cloud computer; BotFleet gives grants on a
shared harness.  For a local single-owner fleet the shared model is very likely
correct and dramatically cheaper.  Worth revisiting only if BotFleet ever
sells multi-tenant, where this stops being an optimization and becomes a
requirement.

### 7.7 Smaller, still-open items

- **Cap and prefix Composio's relayed `tools/list`.**  It is the one unbounded
  third-party input to every prompt.  Bounding it improves cost and reduces
  collision risk at the same time.
- **Namespacing MCP tool names** to the server they came from, closing the
  collision gap in §4.4.
- **A local tokenizer** so `promptBytes` can be converted into an estimated
  token count and paired with `cachedInputTokens` in the harness, rather than
  only in a remote sink.  This is the measurement that would prove win #1.
- **Read and review the webhook ignore-prefilter** (`webhooks.ts:1-1140`) — a
  silent-drop path on the only internet-facing listener.
- **Priority among queued runs** instead of newest-first `reverse()`.

## 8. What Not To Change

Stated so this reads as an evaluation rather than a to-do list.

- **The single-writer bot invariant.**  One boolean, one enforcement site.
  Every concurrency proposal above should be built *around* it, not through it.
- **The stable/volatile prompt split.**  It is the reason win #1 is a one-line
  change.  Preserving byte-identical ordering is load-bearing for both provider
  caching and the Claude spawn contract.
- **Fail-closed at execution, fail-open at listing.**  A deliberate, documented
  trade.  The boundary is `tools/call`, and that is the right boundary.
- **The grant promise holding against a garbling model.**  `connector-verdict.ts`
  refusing an unparseable call is the kind of default that is almost always
  implemented backwards.
- **Spending only on unattended work.**  Nothing else in the design is as
  carefully bounded as this.
- **`doomed-dispatch` leaving the run queued rather than failing it.**
  Refusing to dispatch is not the same as failing the work.

## Appendix: Verification Notes

Structural claims were read from `origin/main` at `532ce508b` and, for the
headline ones, re-verified directly:

- `index.ts:3890` — `.slice(-40)` transcript tail
- `grep -rn "cache_control" server/ shared/ src/` — 0 hits
- `loop.ts:872` — tool result content appended verbatim
- `registry.ts:1189-1191` — `toolsFor` is a pure static filter
- `routines.ts:988-996` — trigger-gap coalescing
- `routines.ts:974-982` — per-bot busy gate
- `shared/bot-profile.ts:22` — `DEFAULT_MAX_TOOL_ROUNDS = 40`

Not verified, and not claimed: any runtime token count, any cache hit rate, any
latency measurement, and the false-positive rate of the webhook prefilter.  The
tool-schema byte counts were produced by bundling the registry and calling
`httpToolDefinitions` with synthetic gate contexts, so the shape is right but
the exact figure for any real bot depends on its grants.
