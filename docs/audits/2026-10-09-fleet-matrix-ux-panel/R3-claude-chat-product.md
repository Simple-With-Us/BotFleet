Lens: Chat-Product (CLAUDE seat, Claude sub-agent).

# The Overview Layer, Read From The Conversation List

Line numbers are at `15263c2b6`.  Comparisons to Slack, Discord and iMessage are conventions from memory, not checked here.  The owner's capture runs Apps mode, not Simple (`settings-workspace-arrangement.webp`; selected style `src/components/SettingsModal.tsx:683`; the Director's nested threads draw only under `showExtraThreads`, `src/components/Sidebar.tsx:2654`).  The default new user is Simple (`shared/conversation-mode.ts:24`) and chat-first.

## Q1: Better Or Worse Than Chat-First?

**Verdict:** Worse for the chat-first user, better for the operator, and only once the counts are honest.

- The strip taxes every room user.  It mounts above every view, Routines and Team Map included (`src/App.tsx:413`, outside the view switch at `:445-512`), once one non-DM room exists (`:104`).  It is 48px, or 84px with an app open (`src/components/AppDeck.tsx:105`, `:285`).
- Constant motion.  Spinners (`src/components/AppDeck.tsx:150`, `:250`) and pulsing dots (`:355-357`) sit in a codebase whose room view keeps avatars still "so a busy group does not become a wall of competing motion" (`src/components/GroupView.tsx:3-5`).
- Its numbers cannot be trusted.  One bot's single state is copied into every room it belongs to (`src/lib/attention-index.ts:1-20`), then summed (`:258-270`).  The first three chips in `kanban-command-center.webp` each show 1 error and 1 working, and Housekeeper reads "Unread" in six rows of `fleet-matrix-grid.webp`, all feeding "18 Unread".  A badge on everything says nothing.
- The gain is real: one scan finds a stuck bot's repo.  The 48px is cheap; the cost is a second navigation system whose numbers nobody believes.

## Q2: Is The Top Of The Pane The Right Home?

**Verdict:** No.  Make the overview a place you go, and take the strip off every other view.

- Above a chat only the deck costs height.  The header card and pills live inside the overview (`src/components/FleetMatrixView.tsx:98-188`), where there is no composer.  The composer is overlaid at the bottom (`src/components/ChatView.tsx:1806`), so the deck shortens the transcript, not the composer.  Per `docs/audits/2026-10-09-fleet-matrix-ux-panel/01-evidence.md` § 1, #827's rule that the overview must not obscure chats is honored by the matrix and stretched by the strip.
- In the overview (my arithmetic from Tailwind classes at 16px rem, not measured; 850px window assumed): 255 to 305px sit above the first matrix row and 270 to 320px above the first Kanban card, about a third of the window.  The header card is about 85px on one line and 130px when its controls wrap.
- Nothing leads there.  The sidebar never mentions the overview (`git grep`: none), the ⌘K palette lists bots, rooms and message hits only (`src/components/CommandPalette.tsx:85-86`), and the sole door is the deck's All tab (`src/App.tsx:419`).  Simple users without rooms never see the deck and have no cross-bot attention view at all: its two consumers both sit behind `src/App.tsx:104` (`docs/audits/2026-10-07-review/R5-ux-frontend.md:45-52`).

## Q3: Which Views Earn A Place?

**Verdict:** Default to a Needs You list copied from the phone.  Keep the matrix as a secondary membership view.  Demote Kanban.

- The phone has the right overview.  Pending approvals come first, one entry per conversation, and "A bot that is idle and read is not an update" (`ios/App/Updates.swift:1-6,33`); the card is answered in place (`ios/App/UpdatesSheet.swift:102`).  The Mac's "Unblock" is a static label on plain navigation (`src/components/KanbanCommandCenter.tsx:543`, `:409-426`).
- The matrix is a membership table.  A cell shows the bot's global state (`src/components/FleetMatrixView.tsx:338-341`), so columns repeat and idle cells say "Assigned" (`:389`).  In Simple every cell of a bot resolves to its one thread (`src/lib/task-app-thread.ts:20-21`; the server refuses bound threads, `server/index.ts:14453-14457`), or after a Projects phase jumps into a hidden one.
- Kanban's 449 "Needs Action" (`kanban-command-center.webp`) ignores acknowledgement.  The sidebar's Routines dot honors `seenAt` (`src/lib/routine-attention.ts:27-28`, `src/components/Sidebar.tsx:2278,3117`); Kanban never reads it (`git grep`: none).
- Missing: the Needs You list itself.  An unmerged `src/components/NeedsYouList.tsx` exists at `092d8fc61` (read, not run; bot-level, no inline answer).  A per-app list is the sidebar; a timeline is the transcript.

## Q4: How Should Threads, Bots And Apps Be Organized?

**Verdict:** The conversation, ordered by recency, is the primary axis.  The deck duplicates the sidebar in a different order.

- Same rooms, two orders: the deck uses store order (`src/components/AppDeck.tsx:57-60`), the sidebar recency (`src/components/Sidebar.tsx:2647-2649`), and the sub-bar repeats room membership (`src/components/AppDeck.tsx:311-367`).  Two pointers answer "where am I", `selectedId` and `selectedAppId` (`src/App.tsx:102`), and the dismissal bug lives in the effect that reconciles them (`:122-137`).  Chat products keep one.
- Naming.  In Slack and Discord vocabulary an app is the bot inside a channel, and this sidebar already says "Connected Apps via Composio" (`src/components/Sidebar.tsx:3134`).  Here "App" is the room.  A grid row reads as an object to inspect, yet typing in its room goes to a default responder that may be everyone (`src/lib/group-routing.ts:5-13`, `server/index.ts:7320-7323`).  The room composer names who answers (`src/components/Composer.tsx:894`); the matrix's "Chat" cell does not (`src/components/FleetMatrixView.tsx:312`).  Two of the five visible rooms in `fleet-matrix-grid.webp` read "No messages yet": for this owner an App is a project record, not a conversation.  Keep the word.  Show the responder before the click.

## Q5: Should Arrangement Grow?

**Verdict:** No new runtime arrangement.  Add one Mac-local setting, Start On, and make the matrix honest in Simple.

- Simple: keep, and make it true (the room "+" is ungated, `src/components/ThreadTabs.tsx:290`).  Bots + Rooms: reject.  Fleet: accept only as the honest name for today's second mode.  Bot Homes: defer; per 02, one busy flag shows "Working" in every home, and presence that lies is worse than none.  Threads: reject; it hides the named bots that Simple exists to show and costs the phone most (it nests bot tasks only, `ios/App/ChatListView.swift:669-675`).  Command Center: reject; no runtime effect.
- Start On is new work.  Nothing persists the selection (`git grep`: none); landing is the hydrate fallback to `bots[0]` (`src/state/store.tsx:1309-1311`, initial `""` at `:2150`).  Messaging apps restore the last conversation, because their list is always on screen.  Aggregate inboxes are places you go, not where the app opens.  Assistant chat apps open on a fresh composer, but Simple has no new chat (one conversation per bot), so restore is the right reading of "Grok-style with named bots".  Values: Last Conversation (default), Needs You (my one addition), Overview.
- Phone: it already has the right overview; make the Mac match it.  It should never get the grid, board or strip, which have no phone form.  "Applies on this computer and on your phone" (`src/components/SettingsModal.tsx:784`) already holds for the arrangement in transport, not in meaning: iOS says "Workspace Layout" (`ios/App/SettingsView.swift:188`).  A Mac-local Start On inside that card would break the promise; give it its own card, "This Computer Only".
- The overview does not make Simple versus Apps moot.  It exposes the matrix as dishonest in Simple.

## Q6: What Must Change Regardless?

**Verdict:** The shortcuts, the counts, the labels and the self-closing view.

- ⌘1 and ⌘2 are also View-menu accelerators for "Chat & Threads" and "Automations & Routines" (`electron/main.mjs:2198,2203`), while the renderer binds ⌘1–9 to bots (`src/App.tsx:165-174`).  Which wins is from code, not run; either breaks a published binding.
- ⌘1–9 and ⌘⇧[ ] index `state.bots` in store order (`src/App.tsx:161,175-185`), not the sidebar's recency order (`src/components/Sidebar.tsx:2611`), with no hint anywhere (`git grep`: code comments only).  In an app, the same chord can switch the bot's thread on the server (`src/App.tsx:169-173`, `src/state/store.tsx:2877-2880`; iOS effect unverified).  ⌘⇧[ ] is Safari's tab chord, yet here it walks bots while the thread bar is "Safari-style" (`src/components/ThreadTabs.tsx:1`).
- The palette's empty state is raw store order (`src/components/CommandPalette.tsx:85`; `src/lib/palette-rank.ts:1-6` assumes pinned or recency order), and bot-to-bot chats list under the Apps heading (`:86`).
- The dock badge counts distinct unread conversations (`src/lib/unread.ts:1-6`); the deck sums per room.  Four different "needs me" counts coexist: dock, Routines dot, deck pills, Kanban.
- Known rows: overview dismissal `6689e3f3`, double count `710979ea`, copy `20725f10`, card flood `fbd2be5e`.  New, no row found: ⌘1/⌘2, selection restore, palette order.

## Ranked Recommendations

1. **Restore where the user was, and make the switcher honest (S).**  Persist `selectedId` locally and prefer it over `bots[0]` at hydrate.  Leave the thread pin out, because the server already holds each bot's active thread (`src/App.tsx:346-349`).  Order the palette's empty state like the sidebar, show the ⌘ number beside each row, index it by what is visible, and settle ⌘1/⌘2.
2. **Make the overview a destination and retire the strip from chats (M).**  Add a sidebar row, a palette entry and a chord, plus Start On in its own Mac-only card.  The chips live in the overview, where rows already are apps.
3. **Define Needs You once, on the phone's rule (L).**  One entry per conversation, pending approvals first, acknowledged runs dropped, the card's options as buttons.  Feed the dock, the sidebar and the overview from it.

## The Owner's Decision

Is BotFleet's default user the chat-first user or the operator?  The owner runs Apps mode and sees the overview as an operator.  New users get Simple and never asked for it.  If chat-first, Start On is Last Conversation, the strip is gone from chats, and the overview is by invitation.  If operator, Start On is Needs You, the strip stays, and the phone gap becomes a stated product difference.
