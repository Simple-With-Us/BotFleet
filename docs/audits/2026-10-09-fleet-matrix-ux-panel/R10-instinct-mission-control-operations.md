Lens: Mission-Control Operations

# Position And Evidence Scope

Keep the overview, but make it a place to decide what needs intervention, not a second inventory of everything.  Preserve conversation-first work and offer an explicit Overview destination.

Reviewed a fresh origin/main worktree at `1cc4257e39d5b9a9a58019af8807f22a6fef595d`, all three panel documents, cited source, and all three supplied screenshots.  Source behavior below is traced, not executed.  Installed-build behavior and usability outcomes are unverified.  The Oct 8 captures are historical evidence, not proof of tonight's build (`docs/audits/2026-10-09-fleet-matrix-ux-panel/01-evidence.md:124-130`).

## Q1: Improvement Over Chat-First

**Verdict: better for supervising several rooms; worse as a compulsory conversation replacement.**  The matrix connects room membership to bot navigation, while the board combines bot state and routine outcomes (`src/components/FleetMatrixView.tsx:324-352`; `src/components/KanbanCommandCenter.tsx:184-215,310-329`).  That is useful when the question is "Where must I intervene?"  Conversation-first remains the better recommendation for someone composing, following one thread, or working without rooms.

The source already keeps the overview opt-in: it starts false, requires a non-DM room, and opens through the deck's All selection (`src/App.tsx:104-105,422-435`).  Preserve that choice.  The matrix capture visibly repeats room navigation beside the sidebar; the board capture visibly mixes hundreds of failures with standby and completed work (`docs/audits/2026-10-09-fleet-matrix-ux-panel/01-evidence.md:127-128`, inspected images).  These are distinct supervision problems, not evidence that chat should disappear.

## Q2: Where The Overview Belongs

**Verdict: keep a compact contextual deck above conversations; put fleet-wide supervision in Overview.**  Today the deck remains above the main pane and the overview replaces its chat content (`src/App.tsx:421-455`).  Recommend a sidebar Overview destination, accessible through the command palette, with the full header and status summary inside it.  The palette is a shortcut, not the only discoverable home.  A room strip can earn its space during room work; a large mission-control header need not consume attention during a conversation.

Do not make the destination room-dependent.  Today's `hasApps` gate hides it without rooms (`src/App.tsx:105,422,455`); a needs-you queue should still serve standalone bots.  This is a proposed extension, not shipped behavior.

## Q3: Which Views Earn Their Place

**Verdict: Needs You should be Overview's default; Matrix and Board should be optional tools.**  Keep chat as the application landing default, with a separate local "Start On" preference.

Matrix earns its place for membership and coverage: it renders every non-hidden bot against non-DM rooms (`src/components/FleetMatrixView.tsx:63-71,324-334`).  It should not imply that every working cell is work in that room: activity is still bot-global (`src/lib/attention-index.ts:7-15`).  Board earns its place for current flow, but a failure card, an idle bot and a completed run are different kinds of item (`src/components/KanbanCommandCenter.tsx:215-309,329-441`).  They are not interchangeable units of workload.

Use one actionable queue with cause, affected room/thread, age, and the decision required.  Offer a per-room list as a filter, not another setting.  Put a timeline in run history rather than add a fourth top-level overview tab.  Current view persistence defaults to Matrix (`src/components/FleetMatrixView.tsx:43-61`); changing that is a proposal.

## Q4: Threads, Bots And Rooms

**Verdict: room for context, bot for execution ownership, thread for conversation history.**  Recommend room-first filtering within Overview, while keeping named bots visible in the conversation sidebar.  Nest bound threads under their room in a room-focused view; retain an explicit bot identity and an Unfiled bucket rather than invent membership from names or sidebar sections.  Membership is `memberIds`; a thread's room binding is a separate lookup (`src/lib/attention-index.ts:13-15`; `src/lib/task-app-thread.ts:19-21`).

The deck duplicates the sidebar's room destinations, but adds a useful room-to-member jump (`src/App.tsx:426-445`; `src/components/Sidebar.tsx:2912-2951`).  Keep it only if it expresses that context, not as a competing master hierarchy.  Label membership "Member", not "Assigned", unless a real task assignment exists: the cell's Assigned state is selected by membership alone (`src/components/FleetMatrixView.tsx:326,380-389`).

## Q5: Arrangement Candidates

**Verdict: clarify two runtime arrangements now; defer new runtime promises.**  Overview does not make Simple versus multiple threads moot: the server still refuses extra bot threads in Simple (`server/index.ts:14503-14510`).

- **Simple: keep.**  Explain existing saved threads honestly.  Mac tabs still render existing tasks and gate only the bot's New action; the room New action is not gated there (`src/components/ThreadTabs.tsx:254-265,279-291`).  Do not promise that one conversation means no other history exists.
- **Bots + Rooms: reject.**  Roomless data already removes the deck (`src/App.tsx:105,422`).  A separate option would confuse a data condition with an execution policy.
- **Fleet: support as clearer naming for multiple threads, not as new automatic concurrency.**  The stored `fleet` alias already means `projects` (`shared/conversation-mode.ts:26-40`).  Do not promise separate models or automation lanes merely by renaming it; the chat header passes no thread override and the picker updates the bot (`src/components/ChatView.tsx:1620`; `src/components/ModelPicker.tsx:547-555`).
- **Bot Homes: defer.**  The room-bound lookup could support stable homes, but automation's default target is still the bot's open thread (`src/lib/task-app-thread.ts:19-21`; `server/index.ts:6806-6813`).  Fix targeting and room-specific attention before making a stable-home promise.
- **Threads: defer as an optional presentation, not the default.**  The sidebar currently nests tasks under bots and rooms (`src/components/Sidebar.tsx:2920-2945`).  Hiding execution ownership would obscure the shared bot constraint (`shared/workspace-settings.ts:17-21`).
- **Command Center: reject as an arrangement; accept as Start On.**  Overview selection is client presentation (`src/App.tsx:104,426-435`), whereas thread admission is server policy.  Keep those controls separate.

No seventh mode proposed.  Do not expose isolation presets whose workspace axis is discarded (`shared/workspace-settings.ts:60-64,140-146`).  Preserve legacy mode values during any migration (`shared/conversation-mode.ts:29-40`).

## Q6: What Must Change Regardless

**Verdict: make quantities, destinations and promises agree.**  "Active Bots" currently means non-hidden bots, not running bots (`src/components/FleetMatrixView.tsx:68-71,157-159`).  Rename it "Visible Bots".  Header Needs Action counts waiting bots, while the board includes dead bots and failed runs (`src/lib/attention-index.ts:17-20`; `src/components/KanbanCommandCenter.tsx:215-248,329-338`).  Give these different names and units.

Run cards still choose a bot/room destination rather than their specific run thread (`src/components/KanbanCommandCenter.tsx:514-530`).  "Unblock" is stronger than that navigation warrants (`src/components/KanbanCommandCenter.tsx:657`).  Use "Open Details" until the action reaches the exact cause.  Surface arrangement-save failures rather than silently catch them (`src/components/SettingsModal.tsx:646-663`).

Do not reopen already-fixed defects from the packet: current main dismisses Overview on selection nonce, deduplicates fleet totals, filters acknowledged failures, groups repeated failures and caps all columns (`src/App.tsx:122-128`; `src/lib/attention-index.ts:277-313`; `src/components/KanbanCommandCenter.tsx:91-118,150-155,321-327`).  Shared arrangement copy now avoids hidden-bot/model promises (`shared/conversation-mode.ts:88-111`).  Installed verification remains outstanding.

## Ranked Recommendations And Owner Decision

1. **S: truth before expansion.**  Align labels, counting units and navigation promises; verify the four existing correction lanes in the installed build, without reopening their rows.
2. **M: a dedicated Overview with Needs You first.**  Keep Matrix/Board secondary, retain contextual room navigation and add independent Start On.
3. **L: earn Bot Homes through runtime guarantees.**  Stable automation targeting and per-room attention must precede new arrangement choices.

**Owner-only decision:** is BotFleet primarily a conversation workspace with optional supervision, or an operations console with optional conversations?  My recommendation is the former, with Overview one deliberate click away.  That choice determines the landing priority; it should not silently change thread, scheduling or isolation policy.
