# Echo Position: Information Architecture

Lens: Information Architecture.  Evidence is at origin/main `1cc4257e` (Fri, Oct 9, 7:23pm).  Cites are `file:line` at that head.  Anything not run is marked.

## Q1  Improvement Over Chat-First?

**Verdict: an improvement at one job only, finding which bot or room needs a human, and a regression everywhere it is read as the product's front door.**  It helps an owner running many rooms.  It does nothing for the owner with one bot, and it is invisible below two rooms because the deck mounts only when a non-DM room exists (`src/App.tsx:105`, `:422`).  The app still opens on a bot chat, not the overview: `matrixOverviewActive` starts false (`:104`) and hydrate picks `bots[0]` (`src/state/store.tsx:1319`).  So the overview is a drawer, not a home.  Since the packet was written, #1021 stopped the overview closing on store updates (`App.tsx:123-129`, dismissal now keyed to `selectionNonce`), #1020 bounded Kanban to unacknowledged work (`KanbanCommandCenter.tsx:321-327`, repeat collapse `:91-118`, cap `:32`), and #1026 counts each bot once (`src/lib/attention-index.ts:277`).  Those were the packet's headline defects.  They are fixed since the packet, so I judge the design as it now stands.

## Q2  Top Pane Or Elsewhere?

**Verdict: the top strip is the wrong home for a destination, the right home for a filter.**  The deck sits above every chat (`App.tsx:422-452`), so it spends vertical space on the one surface (conversation) that needs all of it, to serve a view that is opt-in (it opens only from the "All Apps" chip, `App.tsx:431`).  An overview is a place you go to, and places belong in navigation.  Put "Overview" as the first row of the sidebar above the Director and drop the "All Apps" chip.  The App chips stay as a filter and quick-switch strip only while Overview is open.  The command palette is the weakest home: `CommandPalette.tsx` has no entry for it (grep: no Overview, Matrix or Deck in the file), and a palette is for people who already know the destination exists.  It should get an "Open Overview" action regardless.

## Q3  Which Views Earn Their Place?

- **Kanban Board: earned, make it the default.**  Its columns are verbs (Attention, In Progress, Ready, Completed; `KanbanCommandCenter.tsx` column ids), ranked by what a decision unblocks.  That answers "what do I do next", the overview's only job.
- **Matrix Grid: earned as a secondary view, not the default.**  A bots-by-rooms grid answers "who is in what", which is a setup question.  Its Room Chat column (`FleetMatrixView.tsx:210`) and eight-bot columns scan well, but a cell opens the same conversation in Simple (`src/lib/task-app-thread.ts:20` resolves through `appRef`, which only exists in the projects arrangement).  A grid whose cells are not distinct destinations is overpromising.
- **Missing: a flat Needs You list.**  The 2026-10-07 review asked for it (UX-2, `docs/audits/2026-10-07-review/R5-ux-frontend.md:45-52`), and an unmerged branch has one.  Kanban's Attention column is nearly it, but it is one column among four, not a queue.
- **Missing: per-app view.**  The Kanban app filter takes `filterAppId` (`App.tsx:474`), but "All Apps" nulls that id and an app chip leaves the overview, so the filter has no reachable entry.  The matrix grid ignores it entirely (`FleetMatrixView.tsx:197`).  Open an app from the overview and keep the overview, scoped.
- **Timeline: not yet.**  No data supports it beyond the Routines page.

## Q4  Primary Axis, Nesting, Naming, Duplication

**Verdict: the primary axis is rooms (apps) for attention and bots for identity, and the product currently shows both in two places with different names.**

- **The deck duplicates the sidebar.**  Both list the same rooms: the sidebar under the terminology plural (`Sidebar.tsx:2925-2940`), the deck as one chip per non-DM room (`AppDeck.tsx:167-269`).  A third copy is the matrix column header.  One list should own "which rooms exist" (the sidebar), and the deck should carry only what the sidebar cannot: typed badges.  Move the badges onto the sidebar rows and the deck has no job.
- **Nesting is a setting that does not match the model.**  Bots nest threads and rooms nest threads only in the projects arrangement (`Sidebar.tsx:2663`, `:2896`, `:2924`), yet the data model always allows it (`TaskRecord` per bot) and the Mac tab bar shows every task in both modes (`ThreadTabs.tsx`).  A thread belongs to a bot and optionally to a room (`workspaceContext.appRef`); the sidebar draws only one of those two parents at a time.
- **Names collide.**  "Apps" is a Terminology word and the default word is "Channels" (`shared/terminology.ts`), the Settings card titles itself from that word, the matrix header is "{plural} × Bots", and the unchanged "Room Chat" (`AppDeck.tsx:303`, `FleetMatrixView.tsx:210`) ignores terminology.  `FleetMatrixView.tsx:114` says "software development workspaces" on a product that is not only for software.  An owner reads three names for one object.
- **Sections are layout, not membership.**  `section` is a sidebar divider only (`AppDeck.tsx:22-31`); membership is `memberIds`.  Naming a divider "Apps" and a room an "App" would blur this.

## Q5  Candidates And Overview Versus Simple/Apps

- **Simple, keep.**  It is the smallest honest surface.  Its card says one conversation per bot (`conversation-mode.ts:96`), and the packet notes rollover and one-shot wakes already create tasks without a mode gate (evidence §4, not re-verified).  Keep the mode and gate those.
- **Bots + Rooms split: reject.**  The data does it (zero rooms removes the deck, `App.tsx:105`); it would be a rename.
- **Fleet: accept as the name for today's projects.**  It is what the arrangement already is.  Do it as copy plus the per-thread model picker, nothing server-side.
- **Bot Homes: defer.**  It needs per-room attention (#815 spec) or one working bot reads Working in every home.
- **Threads: reject for now.**  It hides the bot, which is the execution unit.
- **Command Center: reject as a mode.**  It is a view preference, and it should not sync to a phone that cannot show it.  Make it Start On.
- **One new option: Start On (Last Conversation / Overview), Mac-local.**  Stored beside `botfleet.matrix_view_mode` (`FleetMatrixView.tsx:45-57`).  No schema change.
- **Does the overview make Simple and Apps moot?  No.**  The overview ignores the arrangement (no read of it in `App.tsx`, `AppDeck`, `FleetMatrixView`), so it cannot replace it.  But it exposes the arrangement: every Simple cell opening the same chat is the arrangement leaking into the view.

## Q6  Misleading Or Broken Regardless Of Design

Only what reproduces by code at `1cc4257e`.  Not run against live data.

**Fixed since the packet, not argued here:** overview self-dismissal (`App.tsx:123-129`, `useDismissOnSelection` on `selectionNonce`), fleet pill double count (`attention-index.ts:277`, bots deduped by id), the Kanban flood (acknowledged runs skipped `KanbanCommandCenter.tsx:321-327`, repeats collapsed `collapseAttentionCards` `:91-118`, every column capped `:32`, `:148-158`), and the arrangement copy (`shared/conversation-mode.ts:17-18`, `:96-101`; the "turn on Fleet or Projects" server string is gone from `server/`).  The Oct 8 screenshots predate those fixes.

Still true:

- **Kanban's per-app filter has no way in.**  `FleetMatrixView` passes `filterAppId={selectedAppId}` (`App.tsx:474`), and "All Apps" sets that id to null (`:431-433`) while an app chip leaves the overview (`:438-441`).  The matrix grid never uses the prop (`FleetMatrixView.tsx:197` forwards it to Kanban only).
- **A matrix cell has no error state.**  Cell precedence reads only `dead`, `waiting-on-you`, working and unread (`FleetMatrixView.tsx:338-390`), so a bot whose turn errored but is not dead reads "Assigned".  The row badge comes from the attention index, so the two can disagree.
- **A run card opens the bot's app thread, not the run.**  `handleCardClick` routes by `appId` and `botId` only (`KanbanCommandCenter.tsx:514-530`); `rawRun` is read for collapsing and not for navigation.
- **"Room Chat" and the matrix subtitle ignore the user's word.**  `AppDeck.tsx:303`, `FleetMatrixView.tsx:210`; and `:114` says "software development workspaces".
- **Simple opens one conversation from every cell.**  `task-app-thread.ts:20` finds a bound task through `workspaceContext.appRef`, which only the projects arrangement creates.

## Recommendations

1. **S: Kanban becomes the default view, and "Open Overview" joins the command palette.**  Two lines of persistence and one palette action.
2. **M: Move the typed badges onto sidebar room rows, make "Overview" the first sidebar destination, and retire the deck.**  One list of rooms, one place for counts.
3. **L: One object, one name across Mac and iOS, with a per-app scoped overview.**  Resolve Room, App and Channel into a single user-facing word wired through the matrix, deck and sidebar, and add the app-scoped overview.

**Owner-only decision:** is the app a place for several parallel projects (rooms are the front door and the overview is Home), or a place for a few named bots (bots are the front door and rooms are a side feature)?  Every IA choice above flips on that answer.
