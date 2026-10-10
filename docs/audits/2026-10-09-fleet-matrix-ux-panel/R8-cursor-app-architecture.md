Lens: App Architecture (CURSOR).

# The Overview Draws Facts The Runtime Does Not Store

Cites are at `4e296b8c`.  The packet is `4106a5d64`, design pass `1deb1bc91`.  Where this tree moved, the answer says so.  Nothing was run.  "From code" means traced, not executed.  The Oct 8 captures in `screenshots/` are the installed build, not this commit.

## Q1. Reach Improved, Truth Did Not

**Verdict:** Better as a membership map for someone whose rooms are the products they run.  Worse as a report of work, for anyone who trusts a cell.

The shell is still a chat.  The overview starts off (`src/App.tsx:104`) and appears only after All {plural} (`src/components/AppDeck.tsx:106-109`, `src/App.tsx:428-431`).  Launch selects `bots[0]` (`src/state/store.tsx:1318-1319`); `createBot` unshifts (`server/store.ts:1960`).

The grid's real addition is membership (`src/components/FleetMatrixView.tsx:325-326`) and typed badges (`src/components/AppDeck.tsx:219-251`).  The Oct 8 grid also shows the lie: Housekeeper is Unread on every row it belongs to, because the cell uses `bot.unread` (`FleetMatrixView.tsx:341`) and Working uses `bot.activity` (`:340`).  Activity is one field on the bot (`server/store.ts:711-714`).  Assigned means `memberIds` only (`FleetMatrixView.tsx:326`, `:389`).  From code.

## Q2. A Destination, Not A Banner And Not The Palette

**Verdict:** The header card belongs on an overview destination in the sidebar.  The deck does not belong above every chat.  The command palette cannot be the home of either.

`activeView` is `chat`, `team-map`, `routines`, or `skill-recorder` (`src/state/store.tsx:899`).  Team Map and Tasks & Routines are sidebar rows (`src/components/Sidebar.tsx:3088`, `:3115`).  The matrix is a boolean (`src/App.tsx:104`) shown only while that view is `chat` (`:457`).  `Sidebar.tsx` never names it.  The palette is bots, rooms, and hits (`src/components/CommandPalette.tsx:1-15`).  A pick closes the overview via `selectionNonce` (`src/lib/use-dismiss-on-selection.ts:3-11`, `src/App.tsx:124-130`).

The deck sits on every chat (`src/App.tsx:424-454`), so the transcript pays for a second room list.  The header card and pills (`src/components/FleetMatrixView.tsx:99-185`) are the overview's title and should move with it.

Frame-driven dismiss (`6689e3f3`) does not match this tree.  Streams and the launch hydrate leave the overview open (`src/lib/use-dismiss-on-selection.ts:7-13`).  It is still not a place: one chip opens it.

## Q3. Membership Grid, Decision List, No Mixed Board

**Verdict:** Keep the grid as a membership map.  Do not leave it the default.  The default inside the overview should be a needs-you list.  Retire Kanban as a board of mixed objects.

The grid's only two-way fact is membership.  Every other label is the bot's global activity (`src/components/FleetMatrixView.tsx:338-389`).  The stored default is `matrix` (`:43-51`).  That answers "who is on this room?" first.  The Oct 8 kanban capture, and the phone, ask "what needs me?" (`ios/App/UpdatesSheet.swift:39-40`).

Kanban emits one card per visible bot, idle included (`src/components/KanbanCommandCenter.tsx:201-307`), plus one per run (`:310-447`).  Repeats fold (`:84-90`) and a column paints 15 (`:29-32`), but the count is the full set (`:559`), completed runs included (`:403-420`).  A click uses the bot and its first room (`:207`, `:514-523`), never `threadId` on the run (`src/lib/routines.ts:50`).  `rawRun` only collapses (`KanbanCommandCenter.tsx:94`).  The filter needs `filterAppId` (`:551-554`); All {plural} nulls it (`src/App.tsx:429-431`).  From code.

A timeline waits on a stored thread status.  A per-app list is the sidebar plus the deck.

## Q4. Bot, Then Room, Then Thread

**Verdict:** The primary axis is the bot, because that is what the runtime schedules.  Rooms are membership.  Threads are leaves.

There is no App record.  `GroupRecord` is "a room: a shared thread" (`server/store.ts:254-258`).  The matrix titles that row "{singular} / Repository" (`src/components/FleetMatrixView.tsx:206-208`).  The deck lists the same non-DM groups (`src/components/AppDeck.tsx:57-60`).  Sections are dividers, not membership (`src/lib/attention-index.ts:13-15`).

Extra threads nest only when fan-out allows (`src/components/Sidebar.tsx:2662-2663`, `:2896`).  The deck earns badges and the jump into a member's thread (`src/App.tsx:444-447`).  It does not earn a second copy of the names.

## Q5. Do Not Grow The Enum

**Verdict:** Add no arrangement.  Add one shell destination.  The overview does not make Simple versus the projects option moot.  The label does.

- **Simple.**  Keep, once the tab bar obeys it.  The comment promises one conversation (`shared/conversation-mode.ts:4-8`).  Tabs show every task in both modes (`src/components/ThreadTabs.tsx:252-255`); only "+" is gated (`:261-262`).  Sidebar nesting is gated (`Sidebar.tsx:2896`).
- **Bots + Rooms.**  Reject.  No non-DM room already hides the deck (`src/App.tsx:105`, `:424`).
- **Fleet.**  Reject as a stored value.  The comment is today's projects (`shared/conversation-mode.ts:9-15`).  No shipped client sets a per-thread model (`:16-18`).  On disk, `fleet` already means projects (`:37-38`).
- **Bot Homes.**  Not until attention is per room.  Activity is bot-global (`src/lib/attention-index.ts:7-11`) and `bot.busy` is one flag (`shared/workspace-settings.ts:17-21`), so every home would read Working.
- **Threads.**  Reject for now.  Hiding bots hides the scheduled unit (`server/store.ts:711-714`).
- **Command Center.**  Reject as an arrangement.  It would sync a Mac view to a phone with no overview (`ios/App/UpdatesSheet.swift:1-4`).

**One proposal, and it is not a mode.**  Add `overview` to `activeView`, with a sidebar row and a palette entry.  Keep Matrix versus the decision list in `localStorage` beside `botfleet.matrix_view_mode` (`FleetMatrixView.tsx:43-51`).  Do not add a `conversationMode` value.  `02-candidate-arrangements.md` § 3 still governs any new key.  This one needs none.

The overview never calls `getConversationMode` (absent from `AppDeck.tsx`, `FleetMatrixView.tsx`, and `KanbanCommandCenter.tsx`).  Thread gates stay.  The label is what feels moot: the projects radio uses the terminology plural (`src/components/SettingsModal.tsx:683`).  Search (`src/lib/settings-search.ts:41`) and the phone (`ios/App/SettingsView.swift:185`) still say Projects.

## Q6. What Must Change Either Way

**Verdict:** One meaning per word, one click target per object, and no re-specification of defects this tree already changed.

1. Needs Action is three questions.  The pill counts bots in `waiting-on-you` (`src/lib/attention-index.ts:206-208`, `:310`).  Kanban's figure is the attention column, including failed and missed runs (`src/components/KanbanCommandCenter.tsx:329-346`, `:421-441`, `:561-562`).  A chip counts that room's copy (`src/components/AppDeck.tsx:223-251`).  Header totals now dedupe (`attention-index.ts:269-276`).  The capture's 10 Errors and 10 Working are the old sum.  Unverified on the running app.
2. Assigned is membership, and the click is not a task.  `threadIdForApp` falls back to the current thread (`src/lib/task-app-thread.ts:20-21`).  `openBotInApp` calls `switchTask` with no mode check (`src/App.tsx:157-163`).  From code, Simple opens the same conversation from every cell of one bot.
3. Chrome names the wrong object: "software development workspaces" (`FleetMatrixView.tsx:114`), "Room Chat" (`AppDeck.tsx:303`, `FleetMatrixView.tsx:210`), "App / Repository" (`FleetMatrixView.tsx:206-208`) on a room (`server/store.ts:254`).  The phone still says "Keep Extra Threads Hidden" (`ios/App/SettingsView.swift:455`).  The Mac says "Keep Them Out of the Sidebar" (`SettingsModal.tsx:723`).
4. The kanban count and the click, as in Q3.

Do not re-spec what this tree already changed: frame dismiss, deduped header totals, folded repeats, page size 15, and copy that no longer claims bots stay hidden (`conversation-mode.ts:16-18`).  Rows `6689e3f3`, `710979ea`, `fbd2be5e`, and `20725f10` stay on their lanes.

## Better Questions

The six questions judge a layout.  These ask whether the records, the shell, and the screen can tell the truth that layout wants.  Answer them before drawing another arrangement.

### App Architecture

1. **What record is an App?**  Any non-DM room (`FleetMatrixView.tsx:63-66`), titled Repository (`:206-208`), with the folder as another chip (`AppDeck.tsx:212-216`).  One type, or three.  Not a caption.
2. **What is the unit of attention?**  One `activity` on the bot (`server/store.ts:714`).  The grid paints cells, Kanban adds runs, the phone groups bots (Q1, Q3).  Pick bot, pair, thread, or run before picking a view.
3. **Overlay or destination?**  `activeView` exists (`store.tsx:899`).  The overview is a boolean beside it (`App.tsx:104`).

### Framework

4. **Which field is "where I am"?**  `selectedId`, `selectedAppId`, `viewedThreadId`, `matrixOverviewActive`, `activeView`, and a device-local view mode can disagree.  The synced arrangement is read by none of the overview files (Q5).
5. **What may the screen offer that the runtime ignores?**  Dead controls are forbidden (`shared/workspace-settings.ts:57-59`), then roster and fan-out are marked honored (`:60-64`), and only the test imports the module (`server/workspace-settings.test.ts:18`).
6. **What syncs to the phone on purpose?**  A mode whose only effect is a Mac view must not be a synced enum.  Command Center fails that (Q5).

### UI And UX

7. **Does the first screen resume a conversation, or show what needs you?**  The code resumes (`App.tsx:104`, `store.tsx:1318-1319`).  The captures do the other job.  A boolean on the chat pane is not both.
8. **May two controls share a name?**  Only when they share a definition.  Q6 is that failure, already shipped.
9. **When does the deck earn its cost?**  Status and a jump into a member's thread.  Not a second copy of the room names (`AppDeck.tsx:57-60`, Q4).

## Ranked Recommendations

1. **S.**  One meaning per label.  Give the three Needs Action figures one definition, or three names.  Drop Repository, "software development," and Room Chat.  Open a run on its own thread.  Match the phone's hidden-threads button to the Mac.
2. **M.**  Add `overview` to `activeView`, with a sidebar row and a palette entry.  Default it to a needs-you list that opens that thread.  Keep the grid as the membership pane.  Leave the pane choice on this Mac.
3. **L.**  Do not ship Bot Homes or a thread-first roster until activity and the busy flag are per thread or per (bot, room).  That is the model the cells already pretend to show (`attention-index.ts:7-11`).

## One Decision For The Owner

Is the home of this app "resume the last conversation" or "show what needs me"?

The code does the first.  The captures use the second.  Deck placement, the default pane, and whether a new arrangement is even relevant all follow that pick.  No seat can make it.
