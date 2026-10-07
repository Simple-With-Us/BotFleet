# R6 — Bot Collaboration & Orchestration Design (2026-10-07)

Scope: room turn-taking, handoffs (`delegate_bot`, `ask_bot`), shared state, the human approval loop, failure handling and overlapping mechanisms.  Code is at `d2bc60257`.  Live data was read without changing anything: `~/.botfleet/groups.json` and `bots.json` (structure only), `messages.db` opened read-only (pattern counts only) and `decisions.ndjson` (field counts only).

## Findings

### COL-1 [P1] [NEW] Handoff results never reach the bot that delegated
- Evidence: `finalizeDelegationWatch` posts the target's reply only into the A⇄B bot channel (`server/index.ts:4491-4506`).  Nothing steers, wakes or notifies the source thread.  The tool tells the model "Delegation queued — @X will pick it up after your current turn finishes" (`server/index.ts:6611`).  The Chief of Staff prompt says "prefer delegate_bot for anything that might run long", then "wait for the teammate's actual reply before claiming its work is complete" and "combine their results into one coherent answer" (`server/chief-of-staff.ts:92-95`).
- Impact: the product's main team pattern (Chief plus specialists) cannot finish a fan-out.  A Chief either claims work is done without seeing it, or falls back to `ask_bot`, which holds its turn open.  The owner has to read each bot channel to put the results together.
- Recommendation: when a handoff ends (ok, failed or stopped), send a short result notice to the source thread.  Wake the source bot if it is idle and steer it if it is busy.  Reuse `JobWakeCoordinator` and its rules: notices merge, there is a wake cap, and it respects the spend ceiling.  (Effort: M)

### COL-2 [P1] [STILL-OPEN T5] A handoff is cancelled whenever the target is busy, after the model was told "queued"
- Evidence: `server/delegations.ts:261-267` and `:291-299` post "Delegation to @X canceled — @X is busy" and return.  Live, last 30 days: 292 "Delegated to" chips, 84 cancelled because the target was busy (29%), 7 dropped, 15 could not start, 24 did not finish.  Only 187 delegated turns actually started (64%).
- Impact: about a third of handoffs disappear.  The busiest specialists (Deployer was targeted 90 times and Fixer 78) are exactly the ones that lose work.
- Recommendation: wait instead of cancelling (see COL-20 and Course Correction 1).  Cancel only on Stop, or on an expiry the owner can see.  (Effort: S/M)

### COL-3 [P1] [NEW] `delegate_bot` from a room member is deleted without a word
- Evidence: room members are offered the agent tools at hop 0 (`server/index.ts:7231-7232`).  `threadBelongsToBot` accepts room membership (`server/store.ts:2218-2222`), so `queueDelegation` stores the item under the room thread and posts the "Delegated to @X" chip.  When the room turn ends, `drainDelegations` looks up the sender with `botByThread(threadId)` (`server/delegations.ts:169-173`).  That function only matches 1:1 threads and tasks (`server/store.ts:1860-1861`), so the queue is deleted and nothing is posted.  `discardDelegations` behaves the same way (`server/delegations.ts:221-226`).
- Live evidence: ContactLogo room, Sep 21 10:39am: chips for @Builder, @Designer and @Fixer.  There was no "Messaged @" chip in the room and no `[Delegated by` turn anywhere in the fleet in the following hour.
- Impact: the room shows a handoff that never happens, and the bot believes it is queued.
- Recommendation: store `fromBotId` on each queued item and look the sender up by that, not by thread.  Otherwise refuse `delegate_bot` in rooms with a clear error.  Add a room-lane test.  (Effort: S)

### COL-4 [P1] [NEW] Approval cards in unattended turns hold the bot indefinitely and block every queue behind it
- Evidence: in an unattended turn, Auto and always-allow grants turn into cards (`server/auto-approve.ts:484-492`).  Auto-review is switched off for unattended turns (`server/auto-review.ts:36-43`).  The stall watchdog skips turns waiting on a person (`server/turn-watchdog.ts:10-11`).  No code expires a provider permission card on a timer; a search for approval expiry found nothing.  A card only closes on interrupt, teardown or dispose.
- Live evidence, `decisions.ndjson` Aug 28 to Oct 7: 490 cards shown in unattended turns, 120 answered (24%).  368 of them were `unattended-block`, meaning actions the bot's own Auto setting would have approved.  Across all cards the owner approved 154 and denied 2.
- Impact: one alert at 3am parks the bot as busy.  Its room rounds expire after 15 minutes, handoffs to it are cancelled (COL-2), its routines pile up, and `ask_bot` returns `busy`.  The gate produces friction, not decisions.
- Recommendation: give unattended cards a time limit (for example 10 minutes, then deny, end the turn and send one summary notice).  Add exact-key grants the owner sets per routine or webhook that work in unattended turns, and record them in the decision log.  (Effort: M)

### COL-5 [P1] [NEW] Per-turn git worktree leases destroy a bot's work (opt-in, off by default)
- Evidence: acquire runs `git worktree add --force -B botfleet/<bot>/<thread> <path> HEAD` (`server/worktree-leases.ts:221`), which resets the branch to the base HEAD on every turn.  Release runs `git worktree remove --force` (`:256-263`), and `releaseFor` passes no `keepWorktree` (`server/turn-worktree-admission.ts:101`).  Uncommitted edits are lost when the turn ends, and commits are lost at the next turn's `-B` reset.  The feature is off by default (`turn-worktree-admission.ts:19-26`), and 0 live bots have it on.
- Impact: this is the only mechanism for isolating several bots on one repository, and turning it on loses data.
- Recommendation: lease per task, not per turn.  Reuse an existing branch instead of resetting it with `-B`, and keep the worktree on release.  Keep the flag off until that ships.  (Effort: M)

### COL-6 [P1] [NEW] Room turns skip the bot-stop policy
- Evidence: `bot-stop-policy.ts` relies on `startTurn` as "the one place every dispatch passes through".  `runGroupMemberTurn` never calls `startTurn` or `isBotSnoozed`; the only callers are `server/index.ts:3122` and `:4770`.  A stopped bot is therefore still started by a teammate's @mention chain (`:7870-7880`), by drained room rounds (`:4630-4660`) and by connector resumes in rooms (`:8084-8105`).
- Impact: "a bot a person stopped must stay stopped" does not hold in rooms.
- Recommendation: call `decideBotStop` in `runGroupMemberTurn`.  Treat a hop-0 round with no card continuation that a person started as person-initiated, and everything else as system-initiated.  (Effort: S)

### COL-7 [P2] [STILL-OPEN G19, G21, G22] Room queue: Stop misses drained rounds, expiry is silent, removed members still run
- Evidence: drained rounds run with `isCancelled` undefined (`server/index.ts:4641-4651`).  The room interrupt clears only the waiting map (`:11573-11576`), not rounds already chained on `groupQueues`.  Stale rounds are deleted with no notice (`server/room-queue.ts:94-96`).  `ownsThread` checks only the thread, not membership (`server/index.ts:7163-7168`).  A timeout returns `false` (`:7831`), which ends the responder loop (`:7983`), so the remaining responders are skipped without a notice.
- Impact: after Stop, a bot can still speak; requests to speak vanish; work on the to-do list is dropped quietly.
- Recommendation: give drained rounds a cancellable operation, post a notice on expiry or skip, and check membership when draining.  (Effort: S)

### COL-8 [P2] [NEW] Room @mention routing breaks its own promise
- Evidence: every member's prompt says "To bring a teammate in, mention them like @Name — they'll see the conversation and respond" (`server/index.ts:7416`), at any hop.  At hop 1, `hop < MAX_GROUP_HOPS` is false (`:7870`) and the mention is dropped with no notice.  Separately, bot replies are routed through `roomResponders(...{kind:"mentions"})` (`:7874`), which treats `@everyone` as "all members" (`server/store.ts:813`).  This is latent: 0 of 88 bot room messages with an @ used it.
- Impact: bots and the owner wait for a teammate who was never called.  One bot reply could start 10 more turns.
- Recommendation: change the prompt by hop.  Post "not forwarded: one-hop limit".  Never expand `@everyone` from bot-written text.  (Effort: S)

### COL-9 [P2] [NEW] "Everyone" rooms with every bot as a member multiply cost
- Evidence: live, there are 12 rooms, each with 8 to 11 of the 12 bots.  2 of them reply as "everyone".  The busiest "everyone" room logged 60 owner messages, 452 bot replies (7.5 per message) and 1,338 activity rows in 30 days.  Each responder re-reads 30 lines of context in turn (`GROUP_CONTEXT_MESSAGES`, `server/index.ts:6411`).
- Impact: one message costs about 10 sequential turns, mostly repeating each other.  This is the O(N×M) problem the architecture doc warns about.
- Recommendation: make the default responder lead-only, cap or warn on "everyone", and keep rosters small.  (Effort: S)

### COL-10 [P2] [NEW] Bot-to-bot chatter inflates the owner's unread badge
- Evidence: every mirror call marks the bot channel unread (`server/comms-visibility.ts:74`, `:94`, `:116`).  The dock count includes every group, bot channels included (`src/lib/unread.ts:1-6`).  When a room turn settles, the speaking bot's 1:1 is also marked unread though that thread got nothing (`server/index.ts:4395`).  Live: 29 of 36 bot channels are unread and 0 rooms are.
- Impact: the badge mostly counts bot traffic.  `per-room-attention-index.md` says this chatter "must not inflate the unread count".
- Recommendation: leave `dm` groups out of `unreadConversationCount`, and do not mark a bot unread when its room turn settles.  (Effort: S)

### COL-11 [P2] [NEW] Room attention badges copy each bot's global state into every room
- Evidence: `src/lib/attention-index.ts:165-211` builds Errors, Needs Action and Working from the bot's global `activity` and the tail of its 1:1 transcript.  The room's unread count adds every member's 1:1 unread flag (`:210-211`).  The spec names this exact failure: "A bot that died in one room looks identically idle-or-dead in every other room."
- Impact: with every bot in about 11 rooms, one waiting bot lights Needs Action in 11 places.  Badges stop meaning anything.
- Recommendation: hide room badges until a server-side, per-thread view exists (Paseo slice 2).  Until then, use only `busyBotId` and requests the room thread itself opened.  (Effort: M)

### COL-12 [P2] [STILL-OPEN C6] The loop breaker silently drops the owner's own messages
- Evidence: rooms, `server/index.ts:11538-11545`: if any of the last 5 bot messages equals the owner's text, or contains it when the text is over 50 characters, the server returns 200 `ignored: "self_echo"`.  The 1:1 path does the same (`:12384-12391`).
- Impact: quoting a bot's proposed command or commit message back to approve it is discarded.  So is replying "OK" after a bot said "OK".
- Recommendation: apply it only to relay sources (iMessage and Linq).  (Effort: S)

### COL-13 [P2] [STILL-OPEN T6] An `ask_bot` timeout leaves the peer's turn running and its answer lost
- Evidence: `askBotAndWait` gives up after 4 minutes and never interrupts the target (`server/index.ts:1372`).  Live: 14 "(timed out waiting for the bot to reply)" in 30 days.
- Impact: tokens are spent on a turn nobody reads.  The asking bot often asks again.
- Recommendation: on timeout, turn the request into a handoff with a return path (COL-1) instead of dropping it.  (Effort: S)

### COL-14 [P2] [NEW] Handoffs and asks run inside the target's main 1:1 conversation
- Evidence: `runDelegatedTurn` and `askBotAndWait` call `startTurn` with no `threadId` (`server/index.ts:4549`, `:1353`), so it falls back to `bot.threadId` (`:4790`).
- Impact: the owner's unrelated 1:1 history is replayed as context for the handed-off job, and a warm session carries it along.  The handed-off work also lands in the owner's own chat with that bot.
- Recommendation: create a child task on the target for each handoff (automation key = source thread), and close it when the result is delivered.  (Effort: M)

### COL-15 [P2] [NEW] Handoffs and asks skip the spend ceiling
- Evidence: the ceiling is checked only for routine runs (`dispatchHoldFor`, `server/index.ts:1076-1090`) and for jobs (`:1898`, `:1919`).  `startTurn` has no spend check (`:4757-4800`).  A handoff from an unattended turn runs unattended but is not spend-gated (`:4576`).
- Impact: a webhook turn can start 4 handoffs plus any number of `ask_bot` calls past a ceiling that has tripped.
- Recommendation: check `spendBlockedForUnattendedWork` when draining a handoff, and in `askBotAndWait` when the source is unattended.  (Effort: S)

### COL-16 [P2] [NEW] The owner's specialist names are hardcoded into the shipped prompt
- Evidence: every bot that has peers and is not the Chief is told to forward alerts to "Compiler … Deployer … Fixer … Plumber … Housekeeper … Builder" using "delegate_bot (preferred)" (`server/index.ts:5349`).
- Impact: other users' fleets get bot names that do not exist.  For the owner, it pushes every alert toward a handoff, which then runs into COL-2.
- Recommendation: route by `list_bots` titles and descriptions, and make forwarding something each bot opts into.  (Effort: S)

### COL-17 [P2] [STILL-OPEN G23] Warm Claude sessions in rooms are reused or torn down every turn
- Evidence: Claude sessions are keyed by `threadId` alone (`server/drivers/claude.ts:1258-1297`).  Room turns pass no resume cursor (`server/index.ts:7763-7779`).  When the same bot speaks twice, the full 30-line context goes into a session that already holds it.  When two Claude members share one engine instance, their prompts differ, so the session key changes and the process is respawned every turn ("spawn contract changed").  The second part is inferred from the code, not reproduced.
- Recommendation: key room sessions by bot and thread, and send a warm session only the new lines.  (Effort: M)

### COL-18 [P2] [STILL-OPEN C8] Room turns interrupted by a restart vanish
- Evidence: shutdown skips room threads (`server/index.ts:15866`), boot recovery returns null for them (`:6872`), and no notice is posted.
- Recommendation: post one "interrupted by restart — say it again" notice in the room at boot, and clear the leftover in-flight marker.  (Effort: S)

### COL-19 [P3] [NEW] The architecture doc describes mechanisms that do not exist
- Evidence: `docs/architecture/channel-triggers-and-concurrency.md` §1-3 describes an Event Capsule, a payload vault, `read_webhook_payload`, `[PRIOR CHANNEL MEMBER TURN]` framing, and webhooks and routines routed into channels.  A search of `server/` and `shared/` finds none of them.  Routines and webhooks never target rooms, and `server/jobs/wake.ts:21` says "Rooms get notices only".
- Impact: anyone building on this doc builds on things that are not there.
- Recommendation: rewrite it to match the code, or mark it as a proposal.  (Effort: S)

### COL-20 [P2] [NEW] At least nine separate "wait for the bot" queues, each with its own rules
- Evidence: routine runs (saved to disk, `server/routines.ts`), room rounds (memory, 15-minute expiry, `server/room-queue.ts:43`), steer queue (memory, `server/steer-queue.ts:10`), handoffs (saved to disk, cancelled if busy), connector resumes (`server/index.ts:8014`), secret resumes (`:8158`), room rounds waiting on credentials (`:680`), deferred boot recoveries (`:6811`), and job notices.  Each has its own drain trigger, busy check and Stop behaviour.
- Impact: this is the root of COL-2, COL-7 and COL-18.  The owner cannot see what a bot will do next.
- Recommendation: see Course Correction 1.  (Effort: L)

## Course Corrections

1. **One inbox per bot.**  Replace the queues in COL-20 with one saved, ordered inbox per bot.  Every source adds an item: owner messages, room rounds, handoffs, routine and webhook runs, job wakes, card continuations and resumes.  Order: owner first, then handoffs, then automation, then by age.  Nothing is cancelled for being busy, and nothing expires without a notice.  Stop cancels by origin.  The inbox survives a restart and is shown as "Next up" on the bot.  This one change removes most of the silent-drop findings.

2. **Make a handoff a task with a return path, and drop the blocking forms.**  `delegate_bot` should create a child task on the target and deliver its result back to the source like a finished job.  `ask_bot` should become "handoff and wait at most N seconds, then continue on its own".  Bot⇄bot channels should stop being conversations that raise the unread badge and become an audit trail shown in the Team Map.  Then the Chief of Staff can actually orchestrate, and one hop stays a sound limit.

3. **Rooms are for people.**  Default to one lead, keep rosters to 2 to 4 bots, drop "everyone" as a default, and let only the lead (or the owner) bring in a teammate.  Send room turns through the same gates as 1:1 turns (stop, spend, quota cooldown, checkpoint), ideally by making `runGroupMemberTurn` a thin caller of `startTurn`.  The 7.5-replies-per-message room is the clearest cost leak here.

4. **Change unattended approval from "block and wait" to "pre-grant or expire".**  In practice the owner approves 99% of cards and leaves 76% of unattended ones unanswered.  Add exact-key grants per trigger, a time limit with deny and a notice, and one morning summary instead of a card per call.  Keep the hard guards for destructive and sensitive actions.

5. **Pin the workspace before adding parallel work.**  Do Paseo slices 1 and 4 (task-to-workspace binding, plus write ownership by checkout) before more bots touch one repository at the same time.  Keep per-turn worktree leases off until they keep work.  Build the server-side per-thread attention view once, and stop shipping client badges built on global state.

## Fixed Since Prior Audits

| Prior ID | Status | Evidence |
|---|---|---|
| G16 | Fixed | Drained rounds run through `groupQueues` (`server/index.ts:4630-4660`), and the turn is claimed before busy flags move (`:7353-7380`). |
| DR1 | Fixed | Busy state was taken out of the Chief roster (`server/chief-of-staff.ts:31-46`). |
| DR9 | Fixed | `ask_bot` has a 240-second timeout and the prompt prefers `delegate_bot` (`server/tools/registry.ts:223-225`). |
| HS18 / board P0 468b8719 | Fixed (claim narrowed) | A graceful stop now records and classifies what it interrupted (`server/index.ts:15847-15880`).  Only turns the provider never accepted are re-sent.  An accepted turn with a resumable session still gets one "continue" turn (`:6989-6991`), so the P0's claim still holds for those turns, but it is now deliberate, at most 8 per boot, 3 at a time, 2 seconds apart, and never retried after a failure (`server/boot-recovery.ts:52-61`, `:471-491`). |
