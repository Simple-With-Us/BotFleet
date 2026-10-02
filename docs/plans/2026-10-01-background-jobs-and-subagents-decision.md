# Background Jobs and Subagents — Decision

Panel: four scouts, three proposals (Product, Runtime, Integration), a critic and a judge.  Checked against BotFleet `origin/main` `5b9b51d95`, Harness `4ea91a3`, and live probes of Claude CLI 2.1.284 and Codex 0.154.0.

## Decision

- **Background jobs: yes.  BotFleet owns them, for every engine it can reach.**  One registry in the harness server runs the process, keeps the log, shows it in a header dropdown, and wakes the bot with the exit code.  It is modeled on DSH's job system.  HTTP-lane engines get four tools directly.  CLI engines get the same tools through the MCP proxy.  Engine-native background shells cannot be the foundation, because every CLI lane except warm Claude kills its process when the turn ends.
- **Subagents ("Helpers"): show each engine's own, and build no BotFleet runtime.**  Claude and Codex already spawn helpers, and BotFleet renders them wrongly.  BotFleet-level helpers stay `delegate_bot` plus rooms, with live progress on the delegation card.  Background helpers stay off.
- **Containment ships first.**  A live probe proved Claude bots can already start background jobs.  When one finishes, the CLI starts a turn on its own.  That turn lands as a ghost message with no turn record, no watchdog and no spend accounting, and its approvals are auto-denied.
- **Platforms:** full on web, Mac and Linux.  Windows shows the UI but refuses to start jobs.  iOS views jobs, stops them and receives pushes, but never runs them.  Cloud and VM computers wait.

## Engine Matrix

Native means the engine's own feature, passed through.  Emulated means BotFleet's harness-owned job tools.

| Engine | Background jobs | Helpers |
|---|---|---|
| grok (xAI API), minimax, openai-compat | Emulated, first (P1).  BotFleet owns their tool loop, and today their commands stop at 60 s. | Unsupported.  Use `delegate_bot`. |
| Claude | Emulated over MCP (P2).  Native background is off from P0 and adopted later (P5). | Native, typed (P3).  Capped at 3 at once, depth 1. |
| Codex | Emulated over MCP (P2), inside `codex sandbox` unless the bot is full-auto. | Native, typed (P3).  Thread-id fix in P0. |
| DSH | Emulated over MCP (P2).  Its own jobs die at settle, and ACP hides them. | Native, named (by tool name), foreground only. |
| Grok CLI, Kimi, mcode, cursor, droid, opencode, qwen, hermes, deepseekAgent | Emulated over MCP (P2).  Native jobs die at settle. | Named where tool names match (confirmed for Grok and Kimi).  Otherwise unsupported. |
| Antigravity | Emulated, gated until fixtures pass (P2b).  Its MCP mount writes the global `~/.gemini` config under an exclusive lease, and print mode has no approval hook. | Native, named (`invoke_subagent`). |
| pi | Emulated via `pi-mcp-extension` (P2), once it is shown to proxy the tools. | Unsupported until verified. |
| boxagent | Unsupported: remote, opaque, no MCP. | Unsupported. |

## Client Surfaces

- **Web:** one React build served by the harness, so it also covers Mac, Windows and Linux.
  - P1: pill, dropdown, View Output, Stop, Stop All, notice rows.
  - P3: Helper cards.
  - P4: swimlanes and a fleet-wide All Jobs panel.
  - Verified with Playwright screenshot assertions.
- **Mac:** the live UI usually runs a harness forked by Electron, so quitting the app ends jobs.  The dropdown footer says so.  P4 adds desktop notifications.
- **Linux:** same as Mac, behind a flag.
- **Windows:** the UI renders, but `job_start` is refused until a Job Object helper exists, because `taskkill /T` misses re-parented children.
- **iOS (P4, TestFlight):** pill, sheet, notices, Stop, and a push only when the phone's stream is down.
  - Old builds map the new frame to `.unknown`.
  - Each new `/api/jobs*` route must be added deliberately to the companion's default-deny allowlist.

## Design

### Data Model

- **`JobSnapshot`** (in `shared/jobs.ts`):
  - Identity: id `job_<ulid>`, bot, thread, turn, origin (`botfleet` or `native`), kind.
  - What it runs: a redacted label and the working directory.
  - Status: `running`, `stopping`, `completed`, `failed`, `killed` or `lost`.
  - Result and timing: exit code, signal, timestamps, timeout.
  - Delivery: `onComplete` (`wake`, `notice` or `none`), notice state, and `killedBy`.
- **Server-only fields:** pids, file paths, and separate read cursors for the model and the owner.
- **`SubagentSnapshot`:** parent item, depth, fidelity (`typed` or `named`), last activity, tool count, tokens and duration.
- **`automationSource`** gains `"job"`.

### RuntimeEvent Additions

- **P1 adds none.**  The registry broadcasts its own full-set `{kind:"jobs", threadId, jobs}` frame, debounced to 250 ms, which survives reconnects.  The frame carries labels and status, never output.  Output comes over REST.
- **P3:** an optional `subagentId` on `item.*` and `content.delta`, plus `subagent.updated` at most once per second.
- **P5:** `job.updated` for native jobs mirrored from the engine.  A new `onUnsolicitedTurn` driver hook gives every engine-started turn a fresh `turnId`, which keeps the bus's one-completion-per-turn rule intact.

### Lifecycle and Safety Rules

- **Tools:** `job_start`, `job_output`, `job_list` and `job_kill`.
  - The `job_start` row settles immediately, because unsettled rows spin forever.
  - `job_output` returns at most 16 KB of new output and ends with `[status: completed, exit code: 1, 4m 12s]`.
  - The tools mount regardless of `MAX_COMMS_DEPTH`.
- **Runner:**
  - A detached process group, run under `nice -n 10 taskpolicy -c utility` with a `ulimit -t` CPU limit.
  - The environment is `modelShellEnv()` plus `BOTFLEET_JOB_ID`.
  - Output goes to a 0600 file in the data folder through a file descriptor, never a pipe and never `/tmp`.
  - The exit code is written atomically to an `exit` file.
- **Caps:**
  - 3 running jobs per thread, 4 per bot and 8 per host.  Past a cap, `job_start` is refused.
  - Default limit 60 minutes, model maximum 240, owner config up to 6 hours.
  - Logs are capped at 8 MiB.  `jobs.json` holds at most 500 metadata records.
- **Admission:**
  - Refuse on high swap, low free disk, or a tripped spend ceiling.  There is no load-average gate.
  - Thresholds come from a week of resource-watch samples, since swap already sits near 90%.
  - Deadlines count awake time, so a Mac sleep does not expire every job.
- **Stop:**
  - SIGTERM to the group, then SIGKILL after 5 s.
  - A kill by the model suppresses the notice.  A Stop by the owner tells the bot without waking it.
  - The chat Stop button ends the turn, not the jobs.
  - Deleting the thread or bot, or revoking its computer grant, kills its jobs.
- **Restart (v1):**
  - Shutdown stops every job and marks it `lost`.  The updater's quiesce does not stop jobs, because it can still be rolled back; the restart that follows an update does (accepted by the owner 2026-10-02, see "Owner Rulings (2026-10-02)").
  - At boot, a job settles from its `exit` file if one exists.  Otherwise a pid whose start time matches is killed and the job is marked `lost`.
  - No wake turns at boot.  A 5-minute sweep kills stray `BOTFLEET_JOB_ID` processes.
  - `jobs.surviveRestart` waits for a launchd bootout fixture.
- **Approvals:**
  - `job_start` asks, enforced on the server behind the per-turn grant.  A bot in full auto is the one exception and never gets a card, whatever the command or the turn (Owner Rulings, 2026-10-02).
  - It gets its own `job:<program>` namespace in `server/auto-approve.ts` and never inherits bash approvals.
  - An abandoned ask counts as a deny.
- **Redaction and trust:**
  - One `redactSecretsInText` boundary covers labels, output, notices and pushes.  Pushes never carry output.
  - Output read in a wake turn sits inside the same untrusted-data boundary that webhooks use.
- **Wake:**
  - An idle bot gets `startTurn` with `automationSource:"job"`, subject to the one-turn-per-bot rule and the spend ceiling.
  - A busy bot gets the notice through `steer-queue.ts`.  Claude steers mid-turn, and the HTTP loop drains notices between rounds.
  - Each thread gets 3 wakes in a row, refilled by any owner message.
  - Completions within 5 s are merged into one wake.
  - Rooms get notices only.
  - Kill switch: `jobs.wake:false`.
- **Reminder and watchdog:**
  - Every turn with running jobs opens with "Running: job_x `pnpm test` 4m 12s", so an interruption cannot make the bot forget the job or run it again.
  - Job events never touch the 20-minute watchdog.
  - `job_output` waits are clamped to 75 s on the HTTP lane and 120 s over MCP.  The prompt tells the bot not to poll.

### UI

- **Header pill:** sits left of Stop and is hidden when there are no jobs.  It reads "● 2 Jobs · 1 Helper".  The dot pulses blue while anything runs and turns red after a recent failure.
- **Dropdown:** running jobs first, then finished jobs newest first.  Each row shows:
  - a status dot and the command label in monospace;
  - an exit chip such as "Exited 1", "Killed by you" or "Lost after restart";
  - a ticking duration;
  - View Output and Stop.
- **In the thread:** a finished job appears as a "Job Finished" row.
- **Helper card:** replaces the `Agent` or `Task` row and shows live activity, tool count, tokens and duration.
- **Copy:** uses `SENTENCE_GAP` and says "bot".

## Rollout

1. **P0 Containment (S, about 1 day, ships alone).**
   - Claude: set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and the helper caps via env.  Drop frames that arrive with no active turn, and nest rows by `parent_tool_use_id`.  Probe whether `ScheduleWakeup`, `CronCreate` and `Monitor` also start turns on their own.
   - Codex: a `threadId` filter proven by a fixture, or `features.multi_agent=false` until P3.
   - HTTP bash spawned detached, with a group kill.
   - A lost-job detector, and the `backgroundJobs` and `helpers` capability keys.
2. **P1 Registry, HTTP Lane, Web Pill, Wakes (M/L, 3–5 days).**
   - Acceptance: a MiniMax bot runs `job_start "sleep 3; exit 2"`, the pill shows exit 2, the bot is woken, and Stop shows `killed`.
   - Same PR: the `MAC-LOCAL-PROCESSES.md` row (on-demand), the Apple Note refresh, and a janitor skip for `BOTFLEET_JOB_ID`.
3. **P2 MCP Lane (S/M, about 2 days)** for Claude, Codex, ACP and pi.
   - **P2b Antigravity** comes after two fixtures pass: the server-side approval blocks the call, and the global config entry is removed after each turn.
4. **P3 Helpers (M, about 2 days):** typed Claude and Codex cards, named ACP rows, live `DelegationCard`.
5. **P4 iOS and Notifications (M, about 2 days plus TestFlight).**
6. **Later, each conditional:** Claude native adoption, warm DSH sessions (Harness repo only), an HTTP-lane `spawn_worker`, the Windows helper, and cloud and VM jobs.

## Risks and Open Questions

Risks:
- Wake loops, and the cost of wake turns that start with a cold cache.  Tokens per wake are tracked from P1.
- Swap pressure.
- Commands that escape the process group (`nohup`, docker).
- CLI upgrades that change native behavior.
- Secrets in command labels.

Questions for you:
1. **Should wake turns count as unattended?**  That adds spend-ceiling accounting and the untrusted-output boundary, but it can also trigger the switch to a cheaper model.  Recommendation: unattended, with the cheaper-model switch off for job wakes.
2. **How should compound commands be approved?**  Auto-approve refuses anything containing `&&`, `|` or `;`, or over 160 characters.  So `pnpm test && pnpm build` needs an approval card every time, and a wake turn with nobody watching cannot start the next job.  Recommendation: a per-bot list of exact job commands you approve once.
3. **May the phone stop jobs and read output?**  Recommendation: stop yes, output no.
4. **Should jobs be on by default?**  Recommendation: on for HTTP-lane bots at P1, and for CLI bots at P2 once wake cost is measured.

## Dissent

- **Base design:** Integration scored 43, Product 37 and Runtime 36.  Integration's rule is that jobs belong to BotFleet and helpers belong to the engine.  It reaches 17 of 18 drivers with little per-driver code.
- **Claude native background:** Product would adopt it in P2.  Runtime's probe proved ghost turns are live today, so it goes off first.
- **Load gate:** Product and Runtime refused new jobs above 3× the core count.  Load ran 76–173 in every sample, so that gate would disable the feature permanently.
- **Restart:** Product kept jobs running across a restart; Runtime killed them.  Runtime won for v1, because the live harness is usually forked by Electron and ops treats ppid=1 processes as leaks.  The exit file keeps later adoption possible.  Runtime's pipe-to-harness wrapper was rejected because it would rule adoption out.
- **Wake path:** Product and Runtime woke bots through the delegation queue.  That queue rejects self-targets, runs at depth+1 without the job tools, and holds at most 4 items.
- **Antigravity:** Runtime excluded it on a false premise, since it does mount MCP.  It is gated instead.
- **Codex caps:** `agents.max_threads` is reportedly ignored by MultiAgentV2 (issue #33447), so containment uses the feature switch.

## Evidence

- **Probe `scratchpad/bgprobe/out.jsonl`:** after the first `result` come a `task_notification`, a second `init`, text, and a second `result` with `origin.kind:"task-notification"`.
- **Claude driver (`claude.ts`):**
  - `:987-996` drops `task_*` events.
  - `:1013-1068` has no parent check.
  - `:928`, `:933` and `:960` swallow the second result, pause the broker and reuse a stale turn id.
- **Message folding:** `index.ts:2614-2630` appends text without checking for an active turn.
- **Turn-end kills:** `codex.ts:558` ignores `threadId`, and `acp/core.ts:929` kills the engine at settle.
- **Bash limit:** `tools/computer.ts:125` stops bash at 60 s.
- **Turn plumbing:** `harness/bus.ts:66-90` (one completion per turn), `index.ts:2319-2324` (watchdog touch), `delegations.ts:123` (self-target rejection).
- **Antigravity:** `antigravity.ts:1552` declares `agentsMcp:true`.  At `:902`, full-auto passes `--dangerously-skip-permissions`.
- **Ops doc:** `MAC-LOCAL-PROCESSES.md:162` (live harness forked by Electron), `:365` (ppid=1 processes are leaks).

## Board

- Thread telemetry `78129d55` (completed): PRs #730 and #773.
- P0 containment `670389e9` (P1, open).
- Jobs program `01d09729` (P2, open).

## Owner Rulings (2026-10-01)

The owner answered the open questions on Oct 1, 2026.  These rulings override the recommendations above where they differ.

- **(a) Order:** build P0, then P1, now.
- **(b) Wake turns are unattended:** a job wake turn counts as unattended.  It goes through spend-ceiling accounting and sits inside the same untrusted-data boundary webhooks use.  It keeps the bot's same model: there is no cheaper-model fallback for job wakes.
- **(c) Job approval:** a bot set to full-auto (its Auto mode) starts jobs without asking.  Every other bot gets an approval card for every `job_start`, and an abandoned ask counts as a deny.  `job_start` has its own `job:<program>` approval namespace and never inherits bash approvals.  On 2026-10-02 the owner applied this literally: see "Owner Rulings (2026-10-02)" below.
- **(d) iPhone (P4):** the phone may stop jobs and read job output.
- **(e) On by default:** jobs are on by default for HTTP-lane bots at P1.

## P1 Implementation Notes

Where P1 settled a detail the design above leaves open, after review on PR #784.

- **Ruling (c), as read (superseded 2026-10-02):** P1 first read "starts jobs without asking" as Auto mode's own behavior, so the destructive and sensitive guards still stopped `job_start`, and a `job_start` in a turn a webhook, resource alert or text started still asked.  The owner rejected that narrowing on 2026-10-02 and applied the ruling literally, with no carve-out.  A bot in full auto never gets a `job_start` approval card, whether or not the command reads as destructive or sensitive, and in every kind of turn: attended, a webhook's, a resource alert's, a text's, or a job's own wake.  A bot that is not in full auto gets a card for every `job_start`, as before.  The change is in `server/auto-approve.ts` and covers the harness's own `job_start` only.  "Own" is decided by where the request came from, never by its name: it is a request the in-process tool host opened on the permission broker (`isOwnJobStartRequest`, read in the `request.opened` handler in `server/index.ts`), and its tool name must also be `job_start`.  The name alone proves nothing, because a Codex bot reports a mounted MCP server's tool by its bare name, so a third-party `job_start` arrives spelled exactly like the harness's own and keeps every guard that any other MCP tool has, the unattended block included.  The MCP lane (P2) has its own endpoint and must raise its asks on the broker to count.  Bash and every other tool keep all of theirs.
- **Command length:** `job_start` refuses a command longer than an approval card shows whole (2,000 characters, whitespace folded) before any card appears, and tells the bot to write a script file.  Nobody approves a hidden tail.
- **Run limits:** the default and the longest run are the owner's to change, so they are stated in the system prompt's jobs section from the live settings, not in the tool descriptions.
- **Finished logs:** kept a week, and no more than 256 MiB of them between all finished jobs, oldest first, on top of the 500-record cap.  A dropped job's id stays in the sweep's list.
- **Other engines:** a bot switched to an engine without the job tools while its jobs ran is told what ended, without the sentence that sends it to `job_output`, and is not woken for it.
- **Wake turns and Auto mode:** a wake turn is unattended (ruling b), and an unattended turn does not inherit Auto mode.  Ruling (c) is the exception, and since 2026-10-02 it is unconditional: a full-auto bot's `job_start` is auto-approved in its own job wake, so it can start the next job, and in a turn a webhook, resource alert or text started.  Every other tool in an unattended turn, bash included, still asks.  No guard applies to a full-auto bot's `job_start`.  The command-length limit still does, because `job_start` refuses a command too long for the card before any card or auto-approval, so nobody and nothing approves a hidden tail.
- **Updates (a deviation from Restart v1 above, accepted by the owner 2026-10-02):** the updater's quiesce no longer stops jobs, because a quiesce can be rolled back.  The restart that follows an update stops them and marks them lost, the same as any shutdown, so the end state is the same as the design's and a rolled-back update loses nothing.  While the fence is up a job may finish, and its bot is told on the next turn after the restart, not woken.  The owner accepted jobs running through the quiesce fence on 2026-10-02.
- **Tokens per wake:** each settled wake turn's tokens and cost are totalled apart from other turns, overall and per bot, at `GET /api/jobs/wake-usage`.  That is the measurement the P2 decision on CLI bots waits for.
- **Boot:** a group whose leader is gone is never signalled by its number.  The sweep stops exactly the processes carrying the lost job's `BOTFLEET_JOB_ID`.

## Owner Rulings (2026-10-02)

The owner settled two points that P1 had left for confirmation.

- **Full-auto bots never get a job approval card.**  The owner applied ruling (c) literally and rejected the narrowing P1 shipped.  A bot in full auto starts jobs without a card whether or not the command reads as destructive or sensitive, and in a turn a webhook, resource alert or text started as well as in an attended turn or a job's own wake.  Every other bot gets a card for every `job_start`, and an abandoned ask counts as a deny.  Nothing else changes: bash and every other tool keep their guards and the unattended block, a third-party MCP tool that borrows the name `job_start` is not covered, and a `job:` grant is still never remembered.
- **Jobs run through the updater quiesce fence.**  The owner accepted the deviation from Restart v1 in the P1 notes.  A job keeps running while the fence is up, and the restart that follows an update still stops it and marks it lost.

## P2 Implementation Notes

Where P2 settled a detail the design above leaves open, after review.  P2 mounts
the job tools for command-line engines over the MCP proxy the fleet already had;
it did not build a second proxy, and it did not re-decide any of the rulings.

- **The mount is the existing one.**  A command-line engine already receives
  BotFleet's tools as a stdio MCP server named `agents`, spawned per turn
  (`agentsIntegration` in `server/index.ts`, spoken by
  `server/drivers/agents-proxy.ts`).  P2 adds the four job tools to that
  server's `tools/list` and one hop per tool.  The ACP family builds the same
  server through `acpMcpServers`, DSH through Clutch's spawn wrapper, and pi
  through `pi-mcp-extension`, so all of them inherit the mount.
- **Execution stays in the harness, and there is one implementation of it.**
  Every job tool call is a request to `/api/internal/jobs`, answered by
  `server/jobs/mcp-lane.ts` against the P1 registry.  The words a bot reads, the
  fences, the refusals and the untrusted-output fence are `createJobTools`'s —
  the same code the HTTP lane runs — not a second copy that can drift.  What
  differs is where the approval comes from, how long a wait may be, and which
  turn id a job records.
- **Ruling (c) reaches this lane by origin, not by name.**  The lane opens its
  `job_start` ask on the harness's own permission broker, which is what
  `isOwnJobStartRequest` recognises.  That is the whole mechanism: a full-auto
  bot's job start is answered inside `request.opened` with no card, in every
  kind of turn, exactly as on the HTTP lane.  A third-party tool that borrows
  the name cannot reach the broker and so keeps every guard.  The broker is
  also the lane's only answerer, which is why the lane's `respondToRequest`
  story never applies here — the ask is the harness's, not the engine's.
- **`job_output` waits 120 s over MCP, 75 s on HTTP.**  The clamp is a declared
  per-surface deviation on the tool record (`wire.mcp`, with its `reason`), not a
  second number in a driver: an MCP call has no in-process round loop to pay for
  between rounds, so the wait is all the bot spends, while the HTTP lane's 75 s
  sits under a 90-second round budget that cannot move.  The advertised schema
  says which lane it is on, and both numbers are asserted.
- **Identity is the token, never the model.**  The comms grant names the bot and
  thread; the bodies run against that binding and against nothing in the model's
  arguments.  A bot may therefore only read or stop its own jobs.  The mount is
  taken down on `turn.completed`, because a token outlives the turn that minted
  it and a replayed one would otherwise find a finished turn's working folder.
- **Turn ids.**  A CLI-lane job records the engine's turn id, stamped in as soon
  as `sendTurn` returns it, the way an HTTP-lane job records its tool runtime's.
- **Busy bots are steered, not woken.**  An idle bot is woken with
  `automationSource: "job"`, as P1 does.  A busy one is not woken at all: the
  notice is steered onto the turn already running (Claude, via `steer`), and an
  engine with no `steer` leaves it queued for its next turn's opening reminder.
  Either way no wake is scheduled, which is what keeps a busy bot from being
  woken by a job repeatedly.  The steered text says the job ended while the bot
  was *working*, not idle, because that is what happened.  The HTTP lane has no
  such hook and keeps parking a busy bot.
- **One lane derivation.**  `server/jobs/engine-lanes.ts` decides an engine's
  lane from flags the drivers already declare plus the owner's settings, and
  both call sites read it.  `server/jobs/engine-fixtures.ts` is a table of all
  nineteen shipped engines, and its test asserts the table covers
  `BUILT_IN_DRIVERS` — so a new engine cannot land without stating its job
  reach, which is the discipline `computer-capability.fixtures.ts` already keeps
  for computers after that one drifted.
- **The owner's switch.**  `jobs.cliLanes` (default on) returns the command-line
  lane to the HTTP lane alone.  Jobs stay on by default for command-line bots
  too (ruling e).  Per-wake token accounting is P1's, unchanged, and already
  covers these wakes.
- **Unchanged from P1, deliberately.**  The Windows refusal, the per-thread cap,
  admission, the updater-quiesce fence (ruling c), and kill-on-thread-or-bot-
  delete are all registry-level and are reached unchanged by this lane.  A
  command-line job is a process on the same Mac, fenced by the same code.
- **Codex and the sandbox.**  A Codex job is spawned by the harness, not by
  Codex, so it is *not* inside the codex sandbox.  The approval card is what
  stands between a Codex bot and a job, and a full-auto Codex bot is under
  ruling (c) instead.  The decision doc's "inside the codex sandbox" note is
  therefore not what ships, and the driver says so where it is read.
- **Antigravity stays gated (P2b not started).**  Fixture (i) passes: the ask is
  opened in-process, so a job start blocks until a person answers it, and the
  engine has no asks of its own to answer it with.  Fixture (ii) does not.  The
  mount is removed on settle and on abort, but a crash cannot run a returned
  function, and the only sweep (`cleanStaleAntigravityMcp`) runs inside the
  driver's own init — so a crashed turn's entry can sit in the user's global
  `~/.gemini` config pointing at a proxy process that is gone.  Passing it needs
  an unconditional boot-time sweep and a lease TTL, which is a change to a
  shared user-wide file rather than a jobs change.  `backgroundJobs` stays
  `none`, and a test asserts it so the gate cannot be opened by a comment.
- **pi is supported, on evidence.**  `pi-mcp-extension` is a real MCP client, and
  the fixture runs the whole chain with no stand-in in the middle: the real
  extension, driven by a fake pi (the one thing this Mac cannot run), pointed at
  the real `agents-proxy` with `OMB_JOBS=1`, reaching a stub harness — the
  model's `agents_job_start` arrives and the harness's words come back.  The
  driver half is pinned too, so `buildMcpServers` cannot drop the `agents` entry.
