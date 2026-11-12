# Evidence: The Overview Layer And The Workspace Arrangement Setting

Gathered by three read-only scouts on Thu, Oct 8 at main `4106a5d64`, with corrections from a design pass on Fri, Oct 9 at `1deb1bc91`.  Line numbers are at `4106a5d64` unless marked **[HEAD]**, which means `1deb1bc91`.  Main had reached `15263c2b6` when this packet was written, so locate code by the quoted identifier, not the line.  Everything here comes from reading code and git; nothing was run against the owner's data.  "From code, not run" marks behavior that was traced but not executed.

## 1. What Shipped, And Who Built It

Every squash commit is authored by the shared GitHub account, so seats are attributed from the effort-log rows, the branch prefixes, and the pre-squash authors.

| PR | Date | Title | Seat |
|---|---|---|---|
| #813 `6c66089c5` | Oct 3 | refactor(settings): reorder terminology above workspace arrangement | AG (`docs/EFFORT-LOG.md`, "Step 1 of Fleet Matrix") |
| #814 `3015559d4` | Oct 3 | refactor(settings): split conversationMode into four orthogonal axes | MINIMAX |
| #815 `d9e646ffc` | Oct 3 | docs(architecture): specify the per-room attention index the app bar needs | MINIMAX |
| #817 `edd429303` | Oct 3 | docs: Record Source-Backed Paseo Adoption Plan | CODEX |
| #820, #822, #824, #828 | Oct 3 | Task-to-App binding lane | CODEX |
| **#827** `a754db67c` | Oct 3 | feat(ui): Step 3 Fleet Matrix horizontal App Deck, typed badge counters, and matrix navigation | AG (pre-squash author BF-Fixer) |
| #830 `db693bb50` | Oct 3 | fix(attention): enforce explicit memberIds invariant and document bot-global state aggregation | AG |
| #835 `bd69c5d8e` | Oct 4 | fix(ui): explicit thread selection for app matrix and strict room membership | branch `ag/matrix-workspace-fixes` |
| #844 `b8426cb2c` | Oct 4 | feat(ui): surface attention layer error badges, human queue indicators and fleet copy compliance | AG |
| **#851** `510ead29c` | Oct 5 | feat(matrix): add Kanban Command Center and attention-ranked effort board | AG |
| #854 `ed522da6c` | Oct 5 | fix(client): dispatch switchTask when selecting a bot in a specific app context | Cursor Agent and BF-Compiler |

The effort log calls #827 "the user-facing Option C Matrix layout requested by the owner".  No "Option C" design document exists in the repo; the three-seat discussion that produced it is not in the tree.  There is no rollout doc for these views.  The only stated rationale for opt-in activation is #827's commit message: the overview must not intercept or obscure bot chat views and composers.

An unmerged local branch, `ag/matrix-workspace-fixes` (`092d8fc61`), holds a "Needs You" list and an axes-swap toggle.  Neither is on main.

## 2. Where It Lives

Everything is in the desktop renderer under `src/`.  There is no iOS, companion or server counterpart.

| Surface | Component |
|---|---|
| App tab strip ("All Apps", one chip per app, typed badges, "+") | `AppDeck`, `src/components/AppDeck.tsx:44-372`; "All" tab at `:106-165`; per-app chips at `:167-269`; mounted at `src/App.tsx:407-438` behind `hasApps` |
| Header card "Fleet Matrix ({plural} × Bots)" and subtitle | `FleetMatrixView`, `src/components/FleetMatrixView.tsx:99-188`; title `:107-111`; subtitle `:112-116` ("Mission control view across all software development workspaces and assigned bots") |
| Matrix Grid / Kanban Board toggle | `:120-149`; persisted in `localStorage["botfleet.matrix_view_mode"]`, default `matrix` (`:43-61`) |
| Stat pills (Apps, Active Bots, Errors, Needs Action, Working, Unread) | `:151-185`; the last four hide at 0 |
| Matrix Grid | `:200-400`; Room Chat column `:209-211` and `:308-322`; bot columns `:212-238`; cells `:324-394` |
| Kanban Command Center | `KanbanCommandCenter`, `src/components/KanbanCommandCenter.tsx:59-731`, mounted at `FleetMatrixView.tsx:190-199`; cards `:94-353`; columns and sort `:367-397`; Completed cap of 15 at `:28`; filter `:431-451`; count line `:453-463` |
| Overview mount and routing | `src/App.tsx:439-466` |
| Counts behind the badges | `src/lib/attention-index.ts`: `computeRoomAttentionIndex` `:147-238`, `summarizeFleetAttention` `:243-285` |
| Tests | unit tests beside each component; Playwright `tests/e2e/fleet-matrix-view.visual.spec.ts` and `kanban-command-center.visual.spec.ts`; fixtures mounted through `?fixture=` at `src/main.tsx:157-181` |

## 3. How It Behaves

- **Not the landing view.**  `matrixOverviewActive` starts `false` (`App.tsx:99`) and flips on only in the "All Apps" handler (`:411-415`).  The app opens on the first bot's chat: `selectedId` starts empty, hydrate takes `bots[0]` (`src/state/store.tsx:1264-1267`), and `/api/bots` returns disk order where `createBot` unshifts, so `bots[0]` is the newest-created bot, not the Director.  Selection is not persisted.  The first draft of #827 showed the matrix whenever no app was selected, which made it the implicit home; eight minutes later `e6c75eaeb` made it opt-in, and both commits were squashed, so main never had the default-on version.
- **Gating.**  The deck and the overview render only when a non-DM room exists (`hasApps = state.groups.some(g => !g.dm)`, `App.tsx:100`, `:407`, `:440`).  There is no feature flag.  None of `App.tsx`, `AppDeck`, `FleetMatrixView`, `KanbanCommandCenter` or `attention-index` reads the Workspace Arrangement value.
- **Probable self-dismissal (from code, not run).**  The effect at `App.tsx:117-133` (`:121-137` **[HEAD]**) calls `setMatrixOverviewActive(false)` whenever `selectedId` is truthy, and #854 widened its dependencies from `[state.selectedId]` to `[state.selectedId, state.viewedThreadId, state.bots, state.groups, selectedAppId]`.  Any bot or group update closes the overview, and so does the "All" tab itself when a room was selected (it nulls `selectedAppId`).  Board row `6689e3f3`.
- **What an App is.**  Any `Group` with `dm` falsy (`FleetMatrixView.tsx:63-66`, `AppDeck.tsx:57-60`, `KanbanCommandCenter.tsx:70-83`).  There is no separate App entity.  "Apps" is the Terminology word; the default is "Channels" (`shared/terminology.ts:59`).
- **What a bot column is.**  Every non-hidden bot (`FleetMatrixView.tsx:68-71`), including bots with no memberships.  "Active Bots" counts non-hidden bots, not working ones.
- **What "Assigned" means.**  Explicit `group.memberIds` membership and nothing flagged (`FleetMatrixView.tsx:246-247`, `:326`; invariant at `attention-index.ts:13-15`).  It does not mean a task exists.  Cell precedence is Dead, then Needs Action, then Working, then Unread, then Assigned (`:338-390`).  A cell can read "Assigned" while the row badge shows a turn error, because the cell checks only `dead`.
- **What a click does.**  Card actions ("Unblock", "Live Thread →", "Click to prompt") are static labels (`KanbanCommandCenter.tsx:542-545`, `:607`, `:663`); the card's `onClick` calls `handleCardClick` (`:409-426`), which runs `openBotInApp` (`App.tsx:142-149`: `select`, then `switchTask`).  A matrix cell resolves its thread through `src/lib/task-app-thread.ts:6-22`: the bot task bound by `workspaceContext.appRef.id`, else the bot's current thread.  Bound tasks can only be created in the projects arrangement, so in Simple every App cell for a bot opens the same conversation.  `rawRun` is stored on run cards but never read; a failed run opens the bot's app thread, not the run's own thread.
- **The counts measure different things.**  Activity is one scalar per bot (`server/store.ts:1995-2007`), and `attention-index.ts:7-11` says so; a bot's state repeats in every room it belongs to, and `summarizeFleetAttention` sums the rooms, so one working bot in ten rooms reads "10 Working" while Kanban's In Progress column says 1.  Board row `710979ea`.  Header "Needs Action" is `waiting-on-you` (`:189-197`), set when a permission or question card reaches a human (`server/index.ts:3904`).  Kanban's "Needs Action" is the Attention column length: waiting-on-you, dead and no-signal bots plus failed, waiting and missed runs (`KanbanCommandCenter.tsx:125-182`, `:231-268`, `:323-344`), ranked dead 100, no-signal 95, waiting 90, run-waiting 85, run-failed 80, missed 75, then by waiting time, which follows the spec's "rank by what a decision unblocks, then by how long it has waited".  `no-signal` is typed but nothing sets it.  `hasError` and `errorReason` exist only on the server's `MinimalBot`, so the client branches that read them never fire.
- **"1609 Cards".**  One card per visible bot in one of five states, plus every non-cancelled run of a visible bot (`:220-350`).  The client loads runs with no date window (`store.tsx:2977-2978`), the server returns every retained run (`server/index.ts:10368-10378`, `server/routines.ts:576-581`), and retention is 2,000 terminal runs plus all active ones (`routines.ts:355`, `:1855`).  Kanban never reads `seenAt`; the Routines page clears failed and missed runs when opened (`src/components/RoutinesPage.tsx:810-812`, `server/routines.ts:1087-1102`, `shared/routine-outcomes.ts:90`), so Kanban keeps acknowledged failures queued.  Only Completed is capped.  The repeated "Start docker first" cards come from a prompt bug fixed in #959; the failed runs persist in history.  Board row `fbd2be5e`.
- **The Kanban app filter is unreachable.**  `filterAppId={selectedAppId}` (`App.tsx:459`) is always null in practice, because "All Apps" nulls it and an app chip leaves the overview.

## 4. The Workspace Arrangement Setting

- **Stored enum.**  `CONVERSATION_MODES = ["simple", "projects"]` (`shared/conversation-mode.ts:20`), default `simple` (`:24`).  On disk `STORED_CONVERSATION_MODES = ["simple", "projects", "fleet"]` (`:23`); `parseConversationMode` reads `fleet` as `projects` and anything else as `simple` (`:30-33`).  Server schema `server/config.ts:443`; persisted in `~/.botfleet/config.json`; route `PATCH /api/conversation-mode` (`server/index.ts:14276-14290`), allowed from the phone; exposed through `configStatus` (`:8669`).  Client getter `getConversationMode` (`src/state/store.tsx:652-654`).  Settings card `ConversationModeRow` (`src/components/SettingsModal.tsx:629-728`), directly after `TerminologyRow` (`:1369`).
- **"Apps" is the Terminology word, not a mode.**  The second card's title is `mode === "projects" ? labels.plural : copy.title` (`SettingsModal.tsx:672`), and the subtitle interpolates the same word (`:666`).  Both came from #813.  With the default terminology the card reads "Channels".  Terminology (`shared/terminology.ts`, seven presets plus Custom) is resolved server-side to `roomLabels` and is documented as never changing behavior (`server/config-reload-keys.ts:11`); #814's body says it is "deliberately not an axis" because picking "Apps" would imply a behavior change.
- **History.**  Issue #180 (Sep 3) asked for three modes: Simple, Fleet ("current BotFleet, improved": bots with multiple conversations including Triggers and Routines), and Projects.  #181 shipped two, card "Workspace Layout" with literal Simple and Projects, and kept `fleet` as a stored alias (`docs/rollouts/2026-09-03-ios-chrome-workspace-modes.md:7-12`).  #245 added the "Merge Extra Threads?" prompt.  #813 (Oct 3) renamed the card "Workspace Arrangement" and substituted the terminology word.  A withdrawn first draft of #813 (local ref `pr813`, `dfe41f1b3`) added `workspaceLayout: simple|matrix`, `workspaceRoster: bots|threads` and `workspaceFanOut: serial|concurrent` with no readers; reviewers objected that `matrix` could not express projects or fleet, and it was replaced by #814's axes.
- **Unwired groundwork.**  `shared/workspace-settings.ts` (#814) defines `roster: bots|threads`, `fanOut: single|per-room`, `workspace: shared-cwd|worktree-per-task|lease`, `HONORED_AXES.workspace = false` (`:60-64`), and `ARRANGEMENT_PRESETS`: A `bot-team` (equal to Simple), B `shared-apps` ("bots collaborate in the app room, taking turns"), C `app-teams` ("a stable home per bot per app", lease policy).  It is imported only by its own test.  `docs/plans/2026-10-03-paseo-adoption.md:25-27,55` says an App is "a user-facing grouping, not necessarily a Git repository", "The arrangement and scheduling policy remain separate", and asked for an axes-swap that "should change layout only".
- **No document in the repo says the overview invalidates the setting.**  That reading is an inference from the code.

### What `projects` Actually Changes (toggle inventory, **[HEAD]** lines)

| # | Toggle | Where | Class |
|---|---|---|---|
| T1 | Extra bot threads | 409 at `server/index.ts:14453-14457`; client `ThreadTabs.tsx:261`, `TaskPicker.tsx:327`, `store.tsx:1490,1930,2865` | Server-enforced |
| T2 | Extra room threads | 409 at `index.ts:12770-12774`; the Mac room "+" is not gated (`ThreadTabs.tsx:290`, `TaskPicker.tsx:345`) | Server-enforced; the client shows a dead "+" |
| T3 | App-bound bot threads | only through T1's route (`index.ts:14461-14505`), with membership and a folder (`:14471-14476`, `src/lib/task-app-context.ts:10-17`) | Server-enforced |
| T4 | Sidebar nesting | `Sidebar.tsx:2654` and each `tasks={showExtraThreads…}` | Client-only |
| T5 | "Bots" or "Threads" header | `Sidebar.tsx:2655,2866,2926-2929`; the create control is "New Bot" in both modes (`:2805`) | Label-only |
| T6 | Thread tabs | the Mac shows every task in both modes (`ThreadTabs.tsx:79,254`); iOS hides the tab bar in Simple (`ios/App/ChatView.swift:750-752`) | Inconsistent |
| T7 | Automation target | since #470 the first fire of a source goes to `bot.threadId` in both modes (`server/routines.ts:1380-1386`, `server/index.ts:6795-6803`; a projects-mode test asserts two webhooks share one thread, `routines.test.ts:1488-1524`); projects only also accepts a keyed thread that is not the open one (`routines.ts:1359`) | Server-side, narrow |
| T8 | Model scope | the UI writes to the bot (`ModelPicker.tsx:548-553`, `ChatView.tsx:1619`); the server honors a per-thread model (`index.ts:5717,14583-14607`) but no client sends it | Out of reach in the UI |
| T9 | Overview | ignores the mode; a cell resolves through `src/lib/task-app-thread.ts:6-22`; `switchTask` is not gated (`App.tsx:146-153`, `index.ts:14513-14530`) | Client-only |
| T10 | Isolation | the arrangement module ignores it (`shared/workspace-settings.ts:60-64,140-148`); per-turn worktree leases ship behind `features.gitWorktreeLeases` (`server/turn-worktree-admission.ts:19-26`) | Policy, already built elsewhere |

Simple is not strictly one conversation either: rollover (`routines.ts:1391-1416`) and one-shot wakes (`:1462-1478`) create tasks with no mode gate.  Today's `projects` is closer to #180's Fleet than to #180's Projects.

### Copy That Is False Or Stale

- `shared/conversation-mode.ts:89`: "Each thread picks a model" (T8) and "Named bots stay hidden" (bots are listed in both modes, `Sidebar.tsx:2924-2951`); the header comment at `:5-11` repeats both.  Pinned by `SettingsModal.test.tsx:34-57`.
- `src/lib/settings-search.ts:41` "Projects hide named bots"; iOS footer `ios/App/SettingsView.swift:609` likewise.
- iOS titles the picker "Workspace Layout" with literal Simple and Projects (`SettingsView.swift:188`, `:174-193`); the Mac says "Workspace Arrangement" and the terminology plural.
- `server/index.ts:12772,14455` say "turn on Fleet or Projects"; there is no Fleet option.
- Mac only: "Keep Extra Threads Hidden" (`SettingsModal.tsx:712`) leaves the threads visible as tabs.
- "Room Chat" ignores terminology (`AppDeck.tsx:303`, `FleetMatrixView.tsx:210`); `FleetMatrixView.tsx:114` says "software development workspaces"; `AppDeck.tsx:340` "thread in {App}" is false in Simple.

Board row `20725f10` covers the first four.

### Two Latent Bugs Noted By The Design Pass (from code, not run; rows pending)

- In Simple with hidden threads, a matrix cell, an App Deck chip, or ⌘1–9 can switch a bot into a hidden App-bound thread (T9).
- Switching to Simple with "Merge All Threads" refuses threads with different App bindings (`server/store.ts:1578-1586`), and the Mac card swallows that 409 silently (`SettingsModal.tsx:650`).

### Migration Constraint For Any New Stored Value

Before #800 (merged Fri, Oct 9), `loadConfig` treated any schema failure as a first run (`server/config.ts:1127-1133` at `4106a5d64`), so a config file holding a mode value an older build did not know dropped every setting.  #800 replaced that with salvage: the failing section is left out, the rest is kept, and a partial-config notice is raised (`server/config.ts:1270-1308,1361-1394` **[HEAD]**; banner at `src/App.tsx:356`).  Assume every installed Mac and any rollback target is still pre-#800.  `02-candidate-arrangements.md` § 3 has the safe path.

## 5. Data Model

- `GroupRecord` (`server/store.ts:254-291`): "A room: a shared thread where several bots + the user talk".  `memberIds` (`:263`), `dm?` (`:270`), `tasks?: GroupTaskRecord[]` (`:259`), `cwd`, `extraCwds`, `section`, `threadId` (the Room Chat column).  Client `Group` at `store.tsx:195`.
- `BotRecord` (`store.ts:580-707`): `threadId`, `tasks`, `section`, `hidden`, `chiefOfStaff`, `modelSelection`.  Client `Bot` at `store.tsx:322`.
- `TaskRecord` (`store.ts:301`): `threadId`, `workspaceContext` (`:330`), per-thread `modelSelection` (`:333`), `automationKey`.  Client `Task` at `store.tsx:261`.
- `TaskAppRef = {kind:"group", id}` (`shared/task-workspace-context.ts:1-2`).  Bot↔App is `memberIds` only; thread↔App is `workspaceContext.appRef.id`.  `section` is a mutable sidebar divider on both bots and groups and is explicitly not membership (`AppDeck.tsx:22-31`, `attention-index.ts:13-15`).

## 6. Sidebar And iOS

- **Sidebar** (`src/components/Sidebar.tsx:2256`, mounted `App.tsx:399`).  Fixed block order (`:2876-3065`): the unsectioned Chief of Staff bot; a heading from the terminology plural over unsectioned non-DM rooms; a "Bots" or "Threads" heading over unsectioned bots; custom sections (order from localStorage, then first-seen); "Bot Chats" (DM groups), collapsed by default; footer (Team Map, Teach a Skill behind `skillRecorderEnabled`, Tasks and Routines, Connected Apps, profile, update).  Membership is record fields only: `chiefOfStaff`, `section`, `dm`, `pinned`, `hidden`.  `pinned` only sorts bots first within their list.  The Director's "Chief of Staff · …" subtitle is a crown label plus the last-message preview (`:1919-1929`).  The nested rows under Director are the bot's own threads (`bot.tasks`), drawn only when `showExtraThreads` is on (projects), with two or more tasks, and density is not icons.  The Chief block, section order, Bot Chats, the footer, the App Deck and the matrix do not change with the arrangement.  The overview is reachable only from the App Deck's "All" tab; nothing in the sidebar references it.
- **Navigation paths.**  Bot 1:1: row click → `select` → `ChatView`.  Room: `GroupListItem` → `select` → `GroupView`.  An app's threads: a sidebar thread row (`select` then `switchGroupTask` or `switchTask`), or an App Deck chip then a member-bot chip (`openBotInApp`, `App.tsx:142-149`).  ⌘1–9 and ⌘⇧[ / ] index `state.bots` in creation order, not sidebar order (`App.tsx:153-186`).
- **View options and where they persist.**  Matrix/Kanban (`botfleet.matrix_view_mode`); Kanban search and app filter (not persisted); sidebar density, width, threads-per-room (`botfleet.sidebarDensity`, `.sidebarWidth`, `.sidebarThreadCount`); collapsed rooms and sections and section order (`sidebar-preferences.ts:134,174,200-204`); Chat/Trajectory per thread (`src/lib/thread-view.ts:14-74`); skin (`omb-skin`).  All per device.  Terminology and arrangement are server-side and shared with the phone.
- **iOS** (`ios/App/`, `ios/Sources/CompanionCore/`).  Has an apps list (rooms under the terminology plural), a bots list, nested bot threads, and per-bot thread switchers.  No deck, matrix or kanban; the nearest overview is the Updates pill and sheet, grouping active bots by needs-you, working and finished (`ChatListView.swift:529`, `App/UpdatesSheet.swift:1-25`).  Reads `terminology`, `roomLabels` and `conversationMode` from `GET /api/config` (`Models.swift:802-838`, `Session.swift:2259-2282`) and writes them through the same two PATCH routes.  Gaps: rooms come before bots and there is no Chief of Staff field; nested threads for bots only, no disclosure and no cap; the SSE `config` frame is ignored, so a Mac-side change shows only on the next fetch; `sidebarSectionOrder` is read but never sent by the server; labels differ from the Mac ("Workspace Layout", "Room Terminology"); no Team Map or Skill Recorder UI.

## 7. Prior Findings To Build On

- `docs/audits/2026-10-07-review/R5-ux-frontend.md`: "Matrix and Kanban are reachable only through `AppDeck`" (`:10`); UX-2 (`:45-52`) no fleet-wide needs-you queue; UX-4 (`:62-70`) status model too thin; UX-11 (`:116`), UX-16 (`:160`).
- `docs/audits/2026-10-07-review/R6-collaboration.md` COL-11 (`:59`): room badges copy each bot's global state into every room.
- `docs/architecture/per-room-attention-index.md` (#815): the spec the badges were meant to follow ("A bot has exactly one activity, globally", four typed badges never summed across types, per-(bot, room) state with durable errors).  The shipped UI aggregates bot-global state per room instead, and `attention-index.ts:7-11` admits it.
- `docs/audits/2026-10-07-top-to-bottom-review.md`: the synthesis format this panel's synthesis will follow.

## 8. Screenshots

Captured by the owner on Thu, Oct 8 at about 11:47pm from the installed build (the update banner reads "1.0.31, 6 commits ahead", so the build is within six commits of `4106a5d64`).

- `screenshots/settings-workspace-arrangement.webp`: Settings › Terminology (Apps selected) and Workspace Arrangement with the second option, titled "Apps" by the terminology word, selected and reading "Named bots stay hidden", then Channel Turns.  So the owner runs the `projects` arrangement, which is also why the Director shows nested threads in the matrix capture.
- `screenshots/kanban-command-center.webp`: the App Deck (All Apps 10 errors, 10 working, 18 unread; CodeCaps, Clutch, Hog Hunter, BotFleet), the header card in Kanban mode, "1609 Cards · 449 Needs Action · 1 In Progress", four columns, repeated "Run Failed — GitHub UI Pass → Designer — Start docker first" cards.
- `screenshots/fleet-matrix-grid.webp`: the full window; sidebar (Director with BF-DIRECTOR and Overnight Board nested, Apps section, Team Map, Teach a Skill, update banner); the header card in Matrix mode with pills; rows CodeCaps, Clutch, Hog Hunter, BotFleet, AFC+OPS, Usage Monitor, DealDex, Congress.Trade; columns Room Chat, Oracle, Publisher, Plumber, Housekeeper, Monitor, Builder.

The nested rows and the per-row times in the sidebar capture do not match this tree exactly (the code shows a time only on the selected row), which is one more reason to verify against code rather than the capture.

## 9. Verification Conventions

- Web UI changes need Playwright screenshot assertions (`AGENTS.md`, `.github/workflows/e2e.yml`).  `playwright.config.ts` is chromium-only, `maxDiffPixelRatio` 0.02; baselines are `*-chromium-linux.png`, so they are regenerated on Linux, not on this Mac.
- Fixtures mount components through `?fixture=` (`src/main.tsx:25-169`).  Existing specs: `fleet-matrix-view.visual.spec.ts` (two baselines; the fixture mounts `FleetMatrixView` alone, and the baseline reads "Channels × Bots"), `kanban-command-center.visual.spec.ts` (four), `task-app-context.spec.ts` (the only spec with projects plus Apps terminology; attaches screenshots but asserts none), `settings-nav.spec.ts`, `visual.spec.ts` (Settings shows only Profile and Skin above the fold).
- Not covered anywhere: a populated sidebar, the App Deck, the shell-to-overview path, and the Arrangement and Terminology cards beyond unit tests (`SettingsModal.test.tsx:34,59`).
- Docs-only PRs use `pnpm test:ci-scope && git diff --check`; everything else is `pnpm typecheck && pnpm test`, plus `cd ios && swift test` when iOS files change.
