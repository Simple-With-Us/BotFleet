Lens: Builder's Defense (AG seat, Antigravity).

# The Builder's Defense: Why Option C Shipped, What It Solved, And Where It Must Go

Evaluated at HEAD `1cc4257e3`.  All cited files and lines are verified in this worktree.  "From code, not run" marks behavior traced in source without interactive execution.

As the seat that implemented the App Deck (#827 `a754db67c`), Fleet Matrix (#827, #830 `db693bb50`, #844 `b8426cb2c`), and Kanban Command Center (#851 `510ead29c`), AG provides the operational rationale behind these surfaces, built to satisfy an owner directive for multi-workspace mission control.  The four tactical defects noted in the Oct 8 audit—overview self-dismissal (`6689e3f3`), card flooding (`fbd2be5e`), aggregate telemetry overcounting (`710979ea`), and arrangement copy drift (`20725f10`)—were bounding and lifecycle defects now resolved on `main` (PRs #1020, #1021, #1022, #1026).  With those fixes landed, the underlying architecture and product trajectory can be judged objectively.

## Q1: Was The Overview An Improvement Over Chat-First?

**Verdict:** An indispensable operational leap for multi-project supervision, built under the discipline of preserving chat-first interaction.

Prior to #827, BotFleet lacked any multi-bot or cross-workspace operational view.  The interface was strictly a 1:1 conversation list.  Team Map (`src/lib/team-map.ts:45-57`) grouped bots solely by custom section, offering no insight into repository bindings.  An operator overseeing ten projects had to click twenty sidebar items to discover if a task stalled or an approval was pending.

Option C introduced the first spatial overview across workspaces and bots (`src/components/FleetMatrixView.tsx:107-116`).  Crucially, it preserved chat-first interaction:
- The overview was designed as an explicit opt-in view rather than a forced landing screen (`src/App.tsx:104`, where `matrixOverviewActive` defaults to `false`).
- Opening or selecting any bot immediately routes to that bot's active conversation (`src/App.tsx:437-441`).
- The message composer remains fixed at the bottom (`src/components/ChatView.tsx:1803-1806`), so the 48px App Deck strip (`src/components/AppDeck.tsx:105`) never obscures or constrains conversational input.

**Where it succeeded:**
- Fast, two-dimensional spatial scanning of workspace coverage and bot assignments (`src/components/FleetMatrixView.tsx:326`).
- Delivering the first structured attention index with typed counters (`src/lib/attention-index.ts:147-263`) to distinguish actionable errors from background work.

**Where it struggled:**
- Projecting single-scalar bot activity onto room-specific cells before the per-room attention data model was realized (`src/lib/attention-index.ts:7-11`).
- Unbounded ingestion of historical routine runs before deduplication and acknowledgment filtering landed (`src/components/KanbanCommandCenter.tsx:91-119`).

**For whom:** A major upgrade for operators managing autonomous bots across multiple codebases; an unnecessary visual layer for a single-room user.

## Q2: Is The Top Of The Pane The Right Home?

**Verdict:** The top of the pane is the correct home for the horizontal App Deck during active navigation, but the Matrix and Kanban views belong in a dedicated `activeView: "overview"` destination.

The sidebar (`src/components/Sidebar.tsx:2256`) is already vertically congested across more than ten distinct sections (`:2876-3200`).  Adding an orthogonal workspace selector there would worsen vertical scrolling.  Mounting the App Deck at `src/App.tsx:421-453` gave operators an immediate workspace filter without sacrificing transcript width.

However, embedding the heavy Fleet Matrix and Kanban views *inside* `activeView: "chat"` behind a local boolean (`matrixOverviewActive`, `src/App.tsx:104`, `:455`) was an architectural compromise.  Treating mission control as an overlay within chat caused tension with selection reconciliation (`src/App.tsx:127-128`, fixed via `useDismissOnSelection` in PR #1021).

The proper model separates navigation from destination:
1. **The App Deck strip** remains at the top of the pane as a persistent workspace selector and context switcher.
2. **The Fleet Matrix and Kanban Command Center** move to a dedicated `activeView: "overview"` destination (peer to `team-map` and `routines`, `src/state/store.tsx:891`, `src/App.tsx:482-493`), accessible directly from a fixed top row in the sidebar.

## Q3: Which Views Earn Their Place?

**Verdict:** Retain the Matrix Grid for coverage and Kanban for activity, but elevate a dedicated "Needs You" queue as the primary default overview tab.

**1. Matrix Grid (`src/components/FleetMatrixView.tsx:200-400`):**
Earns its place as BotFleet's only 2D staffing and assignment visualization.  While cells currently reflect bot-global activity (`:338-390`), the grid represents the exact visual container required for Bot Homes and per-room thread binding (`shared/workspace-settings.ts:88-92`, `docs/plans/2026-10-03-paseo-adoption.md:25-27`).  Retiring it would discard the UI framework built for upcoming architecture.

**2. Kanban Command Center (`src/components/KanbanCommandCenter.tsx:140-857`):**
Earns its place as an operational activity board.  Its Attention ranking strictly adheres to the Paseo specification (`:381-386`): dead (100) > no-signal (95) > waiting-on-you (90) > run-waiting (85) > run-failed (80) > missed (75).  The run-flooding issue has been resolved by `collapseAttentionCards` (`:91-119`) and `seenAt` recognition in PR #1020 (`c2bc6ba6e`).

**3. What is missing:**
A dedicated, high-density **"Needs You" Action Queue** (as prototyped in `ag/matrix-workspace-fixes` `092d8fc61`).  An operator triaging at 11:00pm needs an immediate list of blockers—unanswered questions, pending permissions, dead bots, failing routines—with inline resolution, not scanning four columns or 110 cells.

## Q4: How Should Threads, Bots, And Apps Be Organized?

**Verdict:** Bots remain sovereign execution units, while Apps serve as workspace boundaries.  The App Deck does not merely duplicate the sidebar, but provides orthogonal workspace filtering.

The claim that the App Deck duplicates the sidebar overlooks operator workflows:
- The sidebar (`src/components/Sidebar.tsx:2876-3065`) is a recency-sorted list of conversations (`:2647-2649`).
- The App Deck (`src/components/AppDeck.tsx:44-372`) is a workspace filter.  Selecting an app filters the sub-bar (`:283-368`) to member bots and routes directly to that bot's room context (`openBotInApp`, `src/App.tsx:155-162`).  The sidebar provides no equivalent.

Where alignment is required:
- **Ordering divergence:** `AppDeck` lists apps in store creation order (`AppDeck.tsx:57-60`), whereas the sidebar orders rooms by activity (`Sidebar.tsx:2649`).  Both should share a unified sort order.
- **Section boundaries:** Custom sections (`bot.section`) belong to Team Map team structures (`src/lib/team-map.ts:45-57`), whereas Apps (`Group`) represent physical workspace repositories (`group.memberIds`, `attention-index.ts:14`).  The App Deck correctly ignored section boundaries (#830).

Hierarchy: Overview destination first; Chief of Staff; Apps (Rooms) containing room chats and member bots; standalone Bots with nested threads; Bot Chats.

## Q5: Should Workspace Arrangement Grow New Options?

**Verdict:** Stabilize `simple` and `fleet` under transparent names; defer `bot-homes` until per-room attention lands; reject superficial pseudo-modes.  The overview does not render arrangements moot.

**Assessment of Candidate Modes:**
- **Simple:** Retain.  Fix the ungated room "+" (`src/components/ThreadTabs.tsx:290`) and enforce that `openBotInApp` never navigates into hidden threads.
- **Bots + Rooms:** Reject.  As `02-candidate-arrangements.md:29-30` notes, zero rooms achieves this automatically.
- **Fleet (#180 Mode 2):** Accept under an honest label ("Multi-Thread Bots").  Enable per-thread model configuration via the existing server route (T8, `server/index.ts:14583-14607`).
- **Bot Homes (Preset B):** The target architecture.  Each bot maintains one stable thread per app room.  However, this must not ship until per-(bot, room) attention indexes (#815) and stable main-thread routing (`server/routines.ts:1380-1386`) are implemented; otherwise, a single busy bot will falsely show "Working" across all homes.
- **Threads (#180 Projects):** Reject.  Hiding named bots obscures bot identity and execution state.
- **Command Center:** Reject as an arrangement mode.  A landing view is a local client preference, not a configuration enum synced to iOS (`02-candidate-arrangements.md:67-70`).
- **Start On:** Accept as a Mac-local setting (`localStorage["botfleet.start_on"]`).
- **Proposed addition:** **Workspace Scope Lock** (a client-side toggle allowing selection in the App Deck to filter the sidebar conversation list to that workspace).

The overview does not moot arrangement: arrangement governs server thread creation constraints (T1, T2, T3) and 409 refusals (`server/index.ts:12770-12774`, `:14453-14457`).  A client view cannot override server data rules.

## Q6: What Is Misleading Or Broken Today That Must Change?

**Verdict:** Four issues must be permanently resolved regardless of final arrangement:

1. **Bot Telemetry Projecting Onto Room Badges (`src/components/FleetMatrixView.tsx:338-390`):**
Displaying a bot's global error or unread state in every room distorts truth.  PR #1026 (`08c93e05b`) deduplicated fleet pills via `Set<string>` (`src/lib/attention-index.ts:285-313`), but grid cells still project global status onto room intersections.
2. **Inconsistent Routine Acknowledgment:**
While `RoutinesPage` clears failures via `seenAt` (`src/components/RoutinesPage.tsx:810-812`), Kanban must maintain strict adherence to acknowledgment so cleared routines never reappear as urgent cards.
3. **Silent 409 Exceptions On Arrangement Downgrade (`src/components/SettingsModal.tsx:650-658`):**
Switching to Simple with "Merge All Threads" fails when threads carry distinct App bindings (`server/store.ts:1578-1586`), swallowed by a silent `catch {}` (`SettingsModal.tsx:658`).
4. **False Settings Copy:**
Settings claiming "Named bots stay hidden" (`shared/conversation-mode.ts:89`) contradicts reality (`src/components/Sidebar.tsx:2924-2951`).  Substituting terminology words into the arrangement title (`src/components/SettingsModal.tsx:666-672`) causes severe conceptual confusion.

## Ranked Recommendations

1. **Promote Overview To A First-Class `activeView` Destination (Effort: M):**
Move Matrix and Kanban out of the `activeView: "chat"` conditional tree into `activeView: "overview"` (`src/state/store.tsx:891`, `src/App.tsx:455-481`).  Add an "Overview" row at the top of `Sidebar.tsx`.  Keep the App Deck as an active workspace switcher.
2. **Elevate The "Needs You" Decision Queue As The Default Overview Tab (Effort: M):**
Introduce the "Needs You" list as the default tab within the Overview destination, utilizing the ranking logic from `KanbanCommandCenter.tsx:381-386` with inline one-click resolution.  Keep Matrix Grid as the "Coverage" tab and Kanban as the "Activity" tab.
3. **Formalize Arrangement Terminology And Safe Config Migration (Effort: S):**
Correct false settings copy, freeze legacy `conversationMode` values, and implement the optional `workspaceArrangement` string field safely per `02-candidate-arrangements.md` § 3.

## The One Decision Only The Owner Can Make

**Whether BotFleet is fundamentally a Bot-Centric Operations Hub (where bots are sovereign entities that visit workspace rooms) or an App-Centric Workspace (where apps are primary project containers and bots are transient assigned resources).**  Every core design decision—from sidebar nesting and thread routing to overview defaults—depends entirely on this foundational architecture choice.
