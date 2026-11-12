Lens: Information Architecture — CODEX.

# Make The Destination Match The Promise

Source baseline: fresh `origin/main` at `4e296b8c8`.  All current-behavior claims below are code-traced, not runtime-tested.  The three supplied screenshots were inspected as historical evidence; installed-build behavior and usability gains remain unverified.  Proposals are design judgments.

## Q1: Improvement Over Chat-First?

**Verdict: useful supervision, incomplete work navigation.**  Matrix earns a place for someone coordinating many bots across rooms: rows are non-DM groups, columns are visible bots, and cells express membership (`src/components/FleetMatrixView.tsx:63-71,324-341`).  A person resuming one conversation benefits less from another navigation layer.

The deck remains above the main pane whenever rooms exist; Overview itself is opt-in (`src/App.tsx:104-105,424-457`).  Thus this supplements chat rather than replacing its default.  Kanban combines bot-state cards and routine-run cards (`src/components/KanbanCommandCenter.tsx:200-207,303-327`): useful for scanning activity, but not evidence that work progresses through a shared task lifecycle.

The architectural weakness is specificity.  A cell resolves the first App-bound task, otherwise the bot's active thread (`src/lib/task-app-thread.ts:19-21`).  Membership, a particular conversation, and an outcome are different things.  The interface needs to distinguish them before operators can trust its shortcuts.

## Q2: Where Should The Controls Live?

**Verdict: Overview belongs in primary navigation; context belongs above the conversation.**  Give Overview a sidebar destination and command-palette entry.  Its header, view switcher, and scoped counts belong inside that destination, compressed into a toolbar.  Keep a compact App breadcrumb/switcher above a conversation; do not require the full fleet strip there.

Today Overview is a shell boolean constrained by `activeView === "chat"`, whereas Team Map and Routines have dedicated views (`src/App.tsx:457-490`).  The palette lists bots, rooms, and message hits (`src/components/CommandPalette.tsx:85-105`).  Neither is a reason to make the palette the sole discoverability path.

The top placement has a legitimate advantage: rapid workspace switching.  Retain that function, with a clear scope indicator.  The current deck passes no App scope to Sidebar (`src/App.tsx:416-454`), so it does not yet organize the navigation beside it.

## Q3: Which Views Earn Their Place?

**Verdict: Needs You should default within Overview; conversation resume should remain the launch default.**  Last-conversation restoration is new work: hydration currently falls back to the first bot (`src/state/store.tsx:1317-1322`).

- **Needs You:** prioritize actionable decisions with an exact destination, age, reason, and resolution state.  The phone already groups Updates into needs-you, working, and review sections (`ios/App/UpdatesSheet.swift:31-41`); reuse that conceptual contract.
- **Matrix:** retain for membership and coverage.  Until room-specific activity exists, put global bot status in column headers; do not imply that every membership is active work.  Cells currently mix global activity with room-local `busyBotId` (`src/components/FleetMatrixView.tsx:324-341`).
- **Kanban:** retain as a secondary activity view pending usage evidence; do not make it the work model.  It now bounds every column and collapses repeat attention runs (`src/components/KanbanCommandCenter.tsx:29-32,66-118,497-502`).
- **Per-App list:** make this the ordinary scoped work view, showing room conversations and bound threads with their bot and execution state.
- **Timeline:** reserve for history and diagnosis, not urgent decisions.

Missing: dependable card-to-thread identity.  Kanban assigns the first member App and ignores the run's thread when navigating (`src/components/KanbanCommandCenter.tsx:310-315,514-530`; `src/lib/routines.ts:50`).

## Q4: What Is The Primary Organization?

**Verdict: work context first, conversation as the destination, bot identity always visible.**  Proposed hierarchy: Overview; Pinned/Recent; {Rooms} with shared conversations and bound threads; a Bots index with unbound conversations and links to bound work.  Selecting a room scopes work without reparenting or duplicating bot identities.  Keep the Chief pinnable, not structurally mandatory.

Membership and binding already have distinct meanings: the deck uses `memberIds` (`src/components/AppDeck.tsx:85-91`); thread context carries a stable group ID and execution directory (`shared/task-workspace-context.ts:1-14`).  Display both when relevant.  A room without a bound thread should offer the bot's general conversation explicitly; several bound threads should open a chooser, not silently pick the first.

**The deck duplicates room selection today:** its chip selects the group (`src/App.tsx:428-435`), while Sidebar independently renders room and bot trees (`src/components/Sidebar.tsx:2912-2959`).  Replace that duplication with a shared scope model and consistent ordering.

Sections need special care: they carry a team brief injected into turns (`server/section-context.ts:1-6`; `server/index.ts:6413,8614`).  Separate team membership from cosmetic navigation grouping; rearranging the sidebar should not silently change instructions.  Use stable arrangement names and consistent room terminology, retaining bot names on thread rows.

## Q5: More Workspace Arrangements?

**Verdict: clarify existing policy before adding modes.**  The candidate menu mixes thread cardinality, presentation, landing preference, and execution policy.

- **Simple — keep:** one readily accessible conversation per bot is valuable.  Specify access to retained threads; Mac tabs currently expose them (`src/components/ThreadTabs.tsx:250-267`).
- **Bots + Rooms — reject:** room presence already controls the deck (`src/App.tsx:105,424`); another mode adds no thread policy.
- **Fleet — accept as a stable name for multiple-thread policy:** implement any promised thread-model picker separately.  Current shared copy correctly describes nested threads and binding (`shared/conversation-mode.ts:84-101`).
- **Bot Homes — defer:** require unique homes, explicit schedule targets, and room-specific attention.  Default routine targeting currently uses the active thread (`server/index.ts:6806-6814`), and bot activity remains global (`src/lib/attention-index.ts:7-11`).  Do not bundle lease isolation; that axis is explicitly unhonored (`shared/workspace-settings.ts:57-64`).
- **Threads — accept app-first presentation, reject hidden execution identity:** show the responsible bot and waiting reason on each thread.  Current global activity cannot explain independent thread progress (`src/lib/attention-index.ts:7-11`).  Prototype this navigation before introducing a stored arrangement.
- **Command Center — reject as an arrangement:** offer a device-local Start On preference; it changes the initial destination, not thread policy.

No additional mode proposed.  The overview does **not** make Simple versus Apps moot: creation is still server-gated (`server/index.ts:12820-12824,14507-14512`), while navigation chooses existing bound threads independently (`src/App.tsx:157-163`).  Mac still borrows the room plural for the option title; iOS says Projects (`src/components/SettingsModal.tsx:680-684`; `ios/App/SettingsView.swift:183-188`).  Fix that naming mismatch.  Preserve the legacy enum when extending settings (`shared/conversation-mode.ts:27-40`; `server/config.ts:509`).

## Q6: What Must Change Regardless?

**Verdict: repair semantic ambiguity without reopening fixed defects.**

The original auto-dismiss, card flood, aggregate overcount, and false-copy findings have source fixes: selection-only dismissal (`src/App.tsx:124-130`), bounded/collapsed cards plus acknowledged failed/missed-run filtering (`src/components/KanbanCommandCenter.tsx:29-32,66-118,321-327`), distinct-ID totals (`src/lib/attention-index.ts:285-312`), and corrected descriptions (`shared/conversation-mode.ts:84-101`).  This does not verify the installed build.

Remaining requirements:

1. **Separate looking from operating.**  Opening an idle bot's bound thread dispatches a switch, POSTs it, and updates shared active state (`src/App.tsx:157-163`; `src/state/store.tsx:2890-2893`; `server/index.ts:14567-14583`).  That affects subsequent default routine targeting (`:6806-6814`).  Browsing should preserve execution destination.
2. **Route and count the named thing.**  Fix run-card attribution/destination from Q3.  “Active Bots” means non-hidden bots (`src/components/FleetMatrixView.tsx:68-71,157-160`); Matrix “Needs Action” counts waiting bots, whereas Kanban counts attention cards (`src/lib/attention-index.ts:310`; `src/components/KanbanCommandCenter.tsx:562-563`).  Label units and scope explicitly.
3. **Explain refused changes.**  Cross-App thread merges throw 409, but Settings discards the failure (`server/store.ts:1575-1586`; `src/components/SettingsModal.tsx:646-664`).  Preserve the refusal and show why.

## Ranked Recommendations

1. **L — Make thread identity explicit end to end:** independent viewing, exact card destinations, explicit execution targeting.
2. **M — Establish one navigation and scope model:** sidebar Overview, compact context switcher, app-scoped thread lists, visible bot identity.
3. **M — Make Needs You the default Overview:** actionable, deduplicated items with explicit units; keep Matrix and activity history secondary.

## The Owner's Decision

Should BotFleet's primary promise be **completing work within an app context**, with bots as visible collaborators, or **maintaining relationships with persistent bots**, with apps as optional scopes?  I favor the former for this fleet, while preserving direct bot conversations.  That priority determines the default hierarchy; another arrangement label cannot decide it.
