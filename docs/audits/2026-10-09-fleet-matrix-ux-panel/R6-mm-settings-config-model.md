Lens: Settings And Config Model (MM seat — authored #814's axes module and the #815 attention spec).

# The Arrangement Is Server Policy, The Overview Is A Client View

Verified at `1cc4257e3`.  **Four of the packet's five defects were fixed today, after it was written** (Q6).  Unrun behavior is marked from code, not run.

## Q1

**Verdict: Better as a status surface, worse as a policy surface — because it was built without reading the config model.**

I wrote `shared/workspace-settings.ts`, and the overview reads none of it.  Grepping `conversationMode`, `resolveWorkspaceSettings` and `workspaceArrangement` across `src/App.tsx`, `FleetMatrixView.tsx`, `AppDeck.tsx`, `KanbanCommandCenter.tsx`, `attention-index.ts` and `task-app-thread.ts` returns nothing.

`projects` is a server-enforced refusal, not a skin: `allowsMultipleBotThreads` (`shared/conversation-mode.ts:43-45`) gates three create routes (`server/index.ts:12820`, `:14507`, `:14557`), each answering 409.  A matrix cell resolves through `threadIdForApp` (`src/lib/task-app-thread.ts:20-21`) and dispatches `switchTask` (`src/App.tsx:155-162`), bypassing every gate, because `switchTask` is a reducer no-op that only swaps the viewed thread (`src/state/store.tsx:1950-1955`).  So in Simple — where App-bound threads cannot be created but survive from before the switch — a deck chip or cell lands the person in a conversation the arrangement says does not exist, with no error.  The grid is also decorative: every cell falls back to `bot.threadId`, so columns differ only in the room header — a real cross-product for a Fleet user, a list of rooms drawn twice for a Simple user.

## Q2

**Verdict: The deck belongs at the top.  The header card and pills belong inside the Overview, not above it.**

The deck is the app's only tab bar (`src/components/AppDeck.tsx:100-167`) and "All Apps" the only route to the overview (`src/App.tsx:411-415`), so adjacency is correct.

But the header card sits between them, so the deck reads as though it navigates to *this card*: `FleetMatrixView.tsx:99-199` renders inside the pane the deck switches, making the deck's selected state and the card's presence the same event.  A separate Overview destination would state the relation plainly — pick a chip, the pane shows that App; pick All, it shows the fleet.  Today "All Apps" means "clear the App filter" and the grid is a bonus.

Reject the sidebar (a record roster already listing rooms, `Sidebar.tsx:2876-3065`) and the palette (⌘1–9 reaches a known bot; the overview reads the unknown whole).

On landing: **the overview must not become the landing view by arrangement.**  `matrixOverviewActive` starts `false` (`src/App.tsx:103`) and selection is not persisted.  Landing is per-device view state, so it belongs in `localStorage` beside `botfleet.matrix_view_mode`, not a server enum a phone with no overview would receive.

## Q3

**Verdict: Keep both.  Default to Kanban in Simple and the Grid in Fleet.  Add exactly one view — Needs You.**

The grid earns its place only where a cell has its own thread; the kanban earns its place in both, because its cards are per-bot state, not per-room.  So the default is arrangement-dependent — the one legitimate reason for the arrangement to reach the client.

The missing view is the fleet-wide needs-you queue prior review asked for and nobody built (`docs/audits/2026-10-07-review/R5-ux-frontend.md:45-52`): a list of decisions waiting on a human, the only thing here with a clock on it.  A timeline is wrong — runs are the unit, and the board already pages them.

## Q4

**Verdict: The bot stays the primary axis.  The deck duplicates the sidebar's room list and should lose the duplication, not the deck.**

Both list the same rooms in the same terminology word: `AppDeck.tsx:167` and `Sidebar.tsx:2913-2923`.  The deck adds horizontal badges and one-click app context, which the sidebar's vertical rows lack.  So keep the deck and let the sidebar be the record list; a room in both is normal.

The naming failure is that the card titles an arrangement with a room word.  `SettingsModal.tsx:672` reads `mode === "projects" ? labels.plural : copy.title`, so with "Apps" chosen the option is titled "Apps" while the refusal at `server/index.ts:14507-14509` says "switch Workspace Arrangement" — pointing at a card whose options are Simple and Apps.  Use the stable names from `shared/conversation-mode.ts:20-21`.

## Q5

**Verdict: No new arrangements ship before the two defects below.  Then exactly one: Bot Homes.  And yes — the overview makes Simple versus Apps partially moot, in the one way that matters.**

**The mootness question, answered.**  Two different things wear the name "Apps".  One is **terminology**, which only renames nouns and is documented never to change behavior (`server/config-reload-keys.ts:11`).  The other is the **arrangement**, which decides whether a bot may hold extra threads at all.

The overview blurs exactly these two by presenting rooms as the primary axis in both arrangements.  A person at the matrix concludes the arrangement is about rooms.  It is about how many conversations a bot may hold; rooms are only where a thread may be filed.  So **the overview makes "Simple versus Apps" moot as a mental model while leaving it entirely real as server policy.**  That gap is the whole problem: the surface teaches the wrong axis.

The fix is not fewer arrangements but different rows.  Matrix rows should be **conversations**, not bots, the moment an arrangement allows more than one.  In Simple every bot is one conversation, so bot-as-row is honest and the grid needs no change.  In Fleet the honest row set is "every thread bound to an app, plus every unbound bot."

**The candidates.**

| Candidate | Verdict |
|---|---|
| Simple | Keep, but make it true.  `settings-search.ts:41` says Projects hides named bots; `Sidebar.tsx:2924-2951` lists bots in both modes. |
| Bots + Rooms | Reject.  With zero rooms the deck and room section already disappear (`src/App.tsx:104`); the split would be copy, not a mode. |
| Fleet | Rename only.  #180 defined it by separate automation threads and #470 removed exactly that; without lanes it is a label plus a model picker no client can send. |
| Bot Homes | **The one to build.**  Only after the attention spec: all of a bot's homes share one busy flag (`shared/workspace-settings.ts:17-21`), so one working bot reads "Working" in every home. |
| Threads | Reject this quarter.  Hiding bots hides why thread B waits on thread A. |
| Command Center | Reject as an arrangement.  Device view state, changes nothing server-side, and would sync a preference to a phone with no overview. |

**My own candidate: Fix the layout key, do not add a mode.**  The enum forces every new arrangement to be a schema change with a migration cliff — under #800 an unknown key is dropped silently, and any install still pre-#800 loses every setting on a bad value.  The arrangement must be a new optional string key beside `conversationMode`, which stays as the mirror.

## Q6

**Verdict: Four of the packet's five defects were fixed today, after it was written.  Two still break, and neither is a design choice.**

**Already landed — the packet is stale, and the panel should not re-litigate these:**

- Overview auto-dismiss (`6689e3f3`) — fixed by #1021, `05619c34a`, Oct 9 4:53pm.  The old effect became `useDismissOnSelection(state.selectionNonce, …)` (`src/App.tsx:128`), firing on a pick, not a streamed update.
- Kanban card flood (`fbd2be5e`) — fixed by #1020, `c2bc6ba6e`, 4:43pm.  Every column is capped at 15 (`KanbanCommandCenter.tsx:32`).
- Fleet pill double count (`710979ea`) — fixed by #1026, `4a7403680`, 5:56pm.
- The false copy — `shared/conversation-mode.ts:18-19` and `:89` now state that Projects does not hide bots and no client sets a per-thread model.

**Still broken:**

1. **"Merge All Threads" fails silently** (`SettingsModal.tsx:646-664`).  `save()` catches and discards — `} catch {` at `:661`, empty.  The store refuses App-bound threads with a 409 before the mode is saved, so the person clicks Simple, sees no change, and believes they switched.  It is the worst defect here: it lies about state.
2. **Simple can be entered without merging, then the overview navigates the leftovers** (`src/App.tsx:155-162`, ungated `switchTask`).  With a card titled by the room word, a person can read a conversation the arrangement does not acknowledge.

Both are preconditions for any arrangement.

## Ranked Recommendations

1. **Make the failure visible and the card stable (S).**  Surface the merge 409 instead of swallowing it; title the options from `CONVERSATION_MODE_COPY`, never the room word (`SettingsModal.tsx:672`).
2. **Close the Simple navigation hole (M).**  Gate `switchTask` in `openBotInApp` on `allowsMultipleBotThreads`, and have the cell name what it opens: "Member" in Simple, "Thread" where an App-bound thread exists.
3. **Fix `workspace-settings.ts` before building on it (M).**  It promises four axes (`:1`) and defines three (`:51-55`); `HONORED_AXES.roster` is `true` (`:60-61`) while the roster only retitles a header; `conversationModeFor` keys off roster (`:152-154`), so preset B derives to `simple` and the server would refuse its threads.  Then add `workspaceArrangement` as a lenient-read, strict-write key beside the legacy enum.

## The Owner's Decision

**Is Simple a real way to work, or should it exist only as the empty state?**  If Simple is first-class, the grid stays bot-shaped, Bot Homes needs a stable home thread, and the attention spec should land before any new arrangement.  If new installs should start in Fleet, per-App threads become normal, the mode card shrinks to one real choice, and the matrix can commit to conversation-rows.  I do not recommend the empty-state answer: an install with nothing on disk reads as Simple (`shared/conversation-mode.ts:16,24`), so every first-run screenshot is Simple.