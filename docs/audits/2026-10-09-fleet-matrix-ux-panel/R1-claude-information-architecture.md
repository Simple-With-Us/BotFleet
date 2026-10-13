Lens: Information Architecture (CLAUDE seat, Claude sub-agent).

# One Tree, One Scope, One Overview

Cites are at `15263c2b6` (the panel worktree adds only docs).  "From code" marks behavior traced but not run.

## Q1

**Verdict:** A gain in reach and a loss in truth: the fleet got its first cross-room view, built on an "App" the data does not have.

The window now has three primary axes.  The sidebar is a conversation list grouped by owner type (Chief, rooms, bots, sections, Bot Chats, `Sidebar.tsx:2882-3071`), with threads nested under owners in projects mode (`:2887`).  The deck and matrix are app-first.  Kanban is card-first, and its cards are bots and runs (`KanbanCommandCenter.tsx:112`, `:221`), not work items.

The App axis is borrowed from the owner's naming.  An App is any non-DM room (`FleetMatrixView.tsx:63-66`); under default terminology the header reads "Channels × Bots".  Most cell facts belong to the bot, not the pair: "Unread" is `bot.unread` (`FleetMatrixView.tsx:341`), one flag per bot (`server/store.ts:604`).  The owner's capture shows Housekeeper "Unread" in every row it belongs to, and opening one of those cells clears them all (`src/state/store.tsx:1512-1516`, from code).

Better at: a one-glance staffing picture and one fleet entry point.  Worse at: counts, cells and labels that report bot facts as App facts.  For whom: better for the owner, whose rooms are mostly named for apps (AFC+OPS is one room for two); worse for anyone whose rooms are not apps, or who trusts a number.

## Q2

**Verdict:** Wrong home.  The overview is a global destination: an `activeView` like Team Map and Routines, with its row at the top of the sidebar.

Team Map, Teach a Skill, and Tasks and Routines are each an `activeView` (`store.tsx:891`, `:1368-1399`) with a sidebar row (`Sidebar.tsx:3078`, `:3092`, `:3106`).  The overview alone is a local boolean in the shell (`App.tsx:103`), opened only by the deck's "All" chip and closed by an effect that fires on any bot or room update while a chat is selected (`App.tsx:122-137`, row `6689e3f3`, from code).  As the app strip's first chip, a fleet-wide view is classed as an app and gated on rooms existing (`App.tsx:104`, `:446`), though Kanban's content is bots and runs.  As an `activeView`, selecting a bot or room leaves it the way it leaves Team Map (`store.tsx:1502`, `:1513`), and a streamed bot update cannot close it (inferred).  The header card and pills suit the overview; the deck strip and its rollup badges should not sit above every chat (`App.tsx:413-444`).

## Q3

**Verdict:** Keep Matrix Grid as today's default, but only as a staffing view; turn Kanban's Attention ranking into a Needs You list, make that the default, and retire the board.

A view earns its place when its axes match facts the data holds.  The matrix's one true two-way fact is membership (`FleetMatrixView.tsx:326`).  Every other cell state reads the bot's global activity or unread flag (`:338-341`); only a room's `busyBotId` is room-specific, because activity is one scalar per bot (`attention-index.ts:7-11`).  So it is a staffing table today, and the right shape only once Bot Homes and per-(bot, room) attention exist (`docs/architecture/per-room-attention-index.md:7`).

Kanban's columns are statuses, but a thread has no status field (`server/store.ts:305-355`).  So the board synthesizes cards from bots and every retained run, and stamps each with the bot's first room as its App (`KanbanCommandCenter.tsx:117`, `:225`), although runs carry `threadId` (`src/lib/routines.ts:50`).  Its ranking follows the spec; its container and contents are wrong.  The missing view is what three documents asked for: ranked decisions, each opening its exact thread (`docs/plans/2026-10-03-paseo-adoption.md:55`; `docs/audits/2026-10-07-review/R5-ux-frontend.md:45-52`).  It exists only on unmerged `092d8fc61`.

## Q4

**Verdict:** One tree (owners, then their threads), the App as a scope over it, the thread as the leaf.  Today the deck duplicates the sidebar.

The Slack test: a rail is a second axis only if choosing in it rescopes the list beside it.  An app chip selects the room (`App.tsx:417-426`), exactly what the sidebar row does, and `Sidebar` receives no app prop (`App.tsx:405-411`).  The two lists also disagree.  "All Apps" is every non-DM room in store order (`AppDeck.tsx:57-60`, `:168`); the sidebar's "Apps" heading holds only unsectioned rooms (`sidebar-preferences.ts:215-216`), sorted by recency (`Sidebar.tsx:2649`).  The capture shows AFC+OPS above BotFleet in one and below it in the other.  The one link between the axes, a thread's App binding, never reaches the sidebar: `Sidebar.tsx` never reads `workspaceContext` or `appRef`, and its label component is imported only by `ThreadTabs.tsx:9`.

Correction to `01-evidence.md`: a section is more than a divider.  It has at most one Chief (`server/store.ts:677-679`), an owner-written brief injected into each member's turns (`server/section-context.ts:1-6`; `server/index.ts:6402`, `:8603`), and it is Team Map's only axis (`src/lib/team-map.ts:45-57`).  The brief keys off `bot.section`, so a room filed under a section carries none of it.  BotFleet therefore has two project containers: the section (a team, one per bot) and the room (members, a folder and a chat, many per bot).  The overview chose the room and disowned the section (`AppDeck.tsx:22-24`).

A clean hierarchy: Overview first; the Chief; {Rooms}, each nesting its threads; Bots, each nesting its threads, App-bound ones titled by App; Bot Chats.  Sections stay teams of bots, owned by Team Map, and rooms stop being filed in them.  Choosing an App narrows the list to its room, member bots and bound threads.  In Simple that shows membership only, because a bot's one conversation spans every App.  Migration is client-only, though rooms filed under sections move out, reversing `server/store.ts:287-289`.

Naming: terminology is "only a display word" (`server/config-reload-keys.ts:11-12`), yet it titles the projects arrangement (`SettingsModal.tsx:666`, `:672`).  With the owner's settings, "App" names four things: a room, that arrangement, third-party integrations ("Connected Apps via Composio", `Sidebar.tsx:3134`) and BotFleet's own settings ("App Settings", `:3198`).  Projects mode heads the bot list "Threads" (`shared/conversation-mode.ts:45-49`) while the matrix calls the same records "Bots" (`FleetMatrixView.tsx:109`).  A room's own chat is "Room Chat", "Team Chat", "team room" and "Chat" (`AppDeck.tsx:294`, `:303`; `FleetMatrixView.tsx:313`, `:317`).  Collapse state is keyed by the word (`Sidebar.tsx:2297`, `:2907-2908`), so renaming reopens the heading.  Renaming a container must change its label and nothing else.

## Q5

**Verdict:** Grow only along fan-out, under fixed names that never borrow the room word.  The overview makes the arrangement matter more, not less.

- **Simple:** keep, with the 02 fixes.
- **Bots + Rooms:** reject; with zero rooms the data already does it.
- **Fleet:** accept today's projects under a fixed, descriptive name ("Many Threads Per Bot"); "Fleet" echoes the product and says nothing.
- **Bot Homes:** the only arrangement that makes a matrix cell mean (bot, App).  Ship it after per-(bot, room) attention and a stable main thread.
- **Threads:** reject.  Hiding the bot hides the execution unit.
- **Command Center:** reject as an arrangement; a landing view is a view preference.
- **Start On:** yes, Mac-local, as 02 proposes.

My one proposal is not an arrangement: the App scope from Q4, which is the "layout only" swap the plan asked for (`paseo-adoption.md:55`).  Is Simple versus Apps moot?  No.  In Simple every cell in a bot's column opens one conversation (`task-app-thread.ts:20-21`), so the overview is honest only where fan-out supports it.

## Q6

**Verdict:** Four things must change whatever ships.

1. **A view click changes shared state.**  In projects mode a cell or chip calls `switchTask` when the App thread differs and the bot is idle (`App.tsx:150`).  That POSTs a switch of the bot's active thread (`store.tsx:2877-2881`, `server/index.ts:14513-14530`), broadcasts it to every client (`:14525`), and decides where an unkeyed source's first automated run lands (`:6795-6803`, 01's T7).  Simple is exposed only through the hidden-thread bug (01 § 4).  It exists because transcripts load only for the active thread (`App.tsx:346-349`); the fix is loading by thread.
2. **Bot facts painted as App facts:** cells, row badges and rollups (`710979ea`).
3. **Kanban's App label is a guess:** `assignedApps[0]`.
4. **"All Apps" and the sidebar's "Apps" are different sets in different orders.**

## Ranked Recommendations

1. **Make the overview a sidebar destination (M).**  Add an `overview` view atop the sidebar, Matrix now and Needs You as default once built; drop the "All" chip and gate nothing on rooms.
2. **Make the App a scope, not a second list (M).**  Replace the chip strip with a scope control narrowing the sidebar and overview; title App-bound threads by App; use one order everywhere.
3. **Stop painting bot facts onto Apps (S).**  Bot status moves to the column header, cells show membership, rollups count distinct bots, Kanban takes its App from the thread's binding or shows none, and no mode borrows the room word.

## The Owner's Decision

Is an App a thing, or a word?  If a thing, it gets its own record (a repository, an optional room, members, bound threads), as the plan described (`paseo-adoption.md:25`), and `TaskAppRef` grows a second kind beside `"group"` (`shared/task-workspace-context.ts:1-2`).  App-first navigation then becomes honest, at L cost including iOS.  If a word, the App stays a room's name, the overview stays a scope over a bot-and-room tree, and no surface may promise per-App structure.  Only the owner can say which product BotFleet is.
