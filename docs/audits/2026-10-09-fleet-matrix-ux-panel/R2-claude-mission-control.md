Lens: Mission-Control Operations (CLAUDE seat, Claude sub-agent).

# Mission Control Cannot Trust This Surface Yet

Basis: code at `15263c2b6` (`src`, `server`, `shared`, `electron` and `ios` unchanged through the panel commit) and the three captures; nothing was run.  The pill and card-bounds lane claims come from uncommitted working copies, not main.

## Q1

**Verdict:** Not yet.  It is the Mac's first fleet aggregate, but it answers "what needs me?" wrongly and confidently, so for one operator it is worse than the roster.  It is better only at showing membership.

- Three surfaces answer "is this bot in trouble?" three ways.  A bot whose visible tail is an error counts as an Error (`src/lib/attention-index.ts:168-171`), but Kanban branches only on `activity` and files it under Standby or In Progress (`KanbanCommandCenter.tsx:125-216`), and its grid cell reads Assigned, Unread or Working (`FleetMatrixView.tsx:338-389`).  In the capture nothing outranks the Run Failed cards (rank 80), so no bot is dead or waiting and the "10 Errors" are error tails, probably one bot counted ten times (inferred from code plus capture).  Once the pill lane lands it should read "1 Error", with no card anywhere.
- Same-screen contradictions: the Needs Action pill hides at zero (`FleetMatrixView.tsx:167`) while the board says "449 Needs Action" (`KanbanCommandCenter.tsx:456-458`); "10 Working" sits beside "1 In Progress".
- The grid is an 11-entry list drawn as up to 110 cells.  Cell state is bot-global except membership and `busyBotId` (`FleetMatrixView.tsx:338-341`), which is why every app chip in the capture shows the same counts.
- The repo solved this twice and the overview reuses neither.  The Routines panel exists because "a count like 421 told the owner nothing they could act on" (`RoutinesPage.tsx:660-667`); the phone's Updates sheet lists needs-you first with inline answers (`ios/App/UpdatesSheet.swift:1-5`, `:102`).

## Q2

**Verdict:** No.  Operations state has to come to the operator; today it waits behind a click.

- The overview opens only from the deck's "All" tab (`App.tsx:413-419`), starts closed (`:103`), and exists only when a room does (`:104`).  The header card and pills exist only while it is open, so they vanish exactly when a bot elsewhere needs you.  The deck, the only persistent strip, hides its scrollbar (`AppDeck.tsx:105`); the capture clips the fifth of ten chips.
- Outside the overview the Mac has no aggregate and no actionable needs-you surface: the roster shows a per-row icon (`Sidebar.tsx:1816-1830`), unfocused notifications fire without actions (`src/lib/notify.ts:41`), the dock counts unread conversations (`src/lib/unread.ts:1`, `electron/main.mjs:190`), and the tray holds only Show, Settings and Quit (`main.mjs:2315-2331`).
- Layer by urgency, as PagerDuty does: interrupt (tray title, notification click-through), glance (a one-line strip atop the sidebar, visible inside any chat), review (a destination that survives store updates).  The palette gets one verb, "next bot waiting on me" (R5 UX-2).  The spec locks the dock ("The dock's existing single number stays", `docs/architecture/per-room-attention-index.md:55`), though its own ranking says four unread replies cost nothing while one open permission stalls a repository (`:59`); that is the owner's call.

## Q3

**Verdict:** Default to a needs-you list.  Demote Kanban to Activity, keep the grid as a bots-as-rows Coverage tab, add a run History.

- Kanban is a status board dressed as a work board: only column one asks for action, and cards move on their own.
- The list holds distinct items (pending decision, failing routine, dead bot, error tail), its count equals its length, and its empty state says "Nothing needs you", as the phone's does (`UpdatesSheet.swift:33`).  The unmerged `ag/matrix-workspace-fixes` draft (`092d8fc61`) renders nothing when empty, links to `/?thread=` which nothing in `src` or `electron` reads, and its axes swap transposes bot-global state per cell, moving the lie.  Do not merge it as is.
- Grid: bots as rows, each bot's status once at the row head, cells as plain membership marks, blank when quiet.  Without per-thread state a grid cannot earn its place: in Simple every cell for a bot opens one conversation (`src/lib/task-app-thread.ts:6-22`; bound threads exist only in projects per 01-evidence, unverified).  Timeline: History only, never the default.
- Copy and skip (product knowledge, not verified here).  PagerDuty: acknowledge versus resolve, one incident per dedupe key; skip escalation.  Linear triage: one inbox, keyboard verbs, snooze; skip team assignment.  GitHub Actions: latest status per workflow, a link to the exact run; skip run history as a to-do list, which is the 1,609 cards.  Vercel: status, age, source and exact log on one row; skip per-project scope.

## Q4

**Verdict:** The bot is the unit of attention and the app is a label.  Yes, the deck duplicates the sidebar.

- The sidebar and the deck list the same rooms in different orders, and typed badges appear on the deck but never on the roster, which is backwards.
- Status is derived in six places that disagree: `Sidebar.tsx:1816-1822`, `attention-index.ts:165-211`, `KanbanCommandCenter.tsx:125-217`, `src/lib/team-map.ts:103`, `FleetMatrixView.tsx:338-341`, `AppDeck.tsx:319-321`.
- Give each roster row one worst-state glyph, counts and reasons on hover (chip tooltips drop the reason `attention-index.ts:175-186` already computes, `AppDeck.tsx:173-175`).  Retire the deck or shrink it to a breadcrumb.
- Attribute state to an app only through `busyBotId` or a thread's `appRef` (`botActivityLocation`, `src/lib/sidebar-activity.ts:96-105`), else show it at bot level; R6 COL-11 agrees.  Naming: Need You, Failing, Working; "Member", not "Assigned".

## Q5

**Verdict:** Ship Start On now; add no thread-multiplying mode until attention is per-thread.

- Simple: keep, and make its card true.  Bots + Rooms: reject; copy, not a mode.  Fleet: harmless to operations.  Bot Homes: defer; all homes share one busy flag, so one working bot lights every home (02's own objection).  Threads: the right unit for a queue, since a thread is what waits on you, but it hides the execution unit; defer.  Command Center: a view preference, so it belongs under Start On.
- My one proposal: Start On = Last Conversation, Overview, or Needs You when something waits (else the last conversation).  Mac-local, no migration (the storage pattern at `FleetMatrixView.tsx:43-61`).
- Does the overview make Simple versus Apps moot?  No: the queue is arrangement-proof, while in Simple the grid has no per-app meaning.

## Q6

**Verdict:** After the four lanes, fix these in order of trust damage: a number with nothing behind it, numbers that disagree on one screen, then false attribution.

1. The red number has nothing behind it.  Error tails get no card (Q1), and a cell that checks only `dead` (`FleetMatrixView.tsx:338`) sits beside a row that counts tails (`attention-index.ts:171`).
2. One definition per number.  "Needs Action" means waiting bots in the header and column length on the board.  Make every pill a button that opens exactly the items it counted; today they are bare divs (`FleetMatrixView.tsx:153-184`).
3. Attribution.  The pill lane fixes the sum, but per-room counts remain, so one bot still lights every app chip.  Kanban labels each card `assignedApps[0]` (`KanbanCommandCenter.tsx:117`, `:225`), which is why every card in the capture that names an app says CodeCaps.
4. Failure semantics.  The card-bounds lane honors Routines-page acknowledgements, but Kanban cannot acknowledge, and "GitHub UI Pass → Designer" shows an 11:35pm success beside its 96-hour failures.  Queue membership should be "this routine's latest run is failing", as in GitHub Actions.  A later success leaves the queue without acknowledging, since the Routines badge keeps per-run, ack-only history (`server/routines.ts:1115-1131`) and I infer a failed webhook delivery is lost work.
5. Dead controls.  `statusKind` is never read (`KanbanCommandCenter.tsx:42`), so dead, failed and waiting all render amber (`:495-498`).  "Unblock" (`:542-545`), "Live Thread →" (`:607`) and "Click to prompt" (`:663`) all run `handleCardClick` (`:409-426`), which ignores `rawRun`.
6. Absence shown as fine.  `no-signal` is typed and never set (`server/store.ts:561-563`), and none of the three overview components reads `connected`, so a wedged harness leaves frozen numbers unmarked (inferred from grep).

## Ranked Recommendations

1. **Make The Attention Queue A Decision Queue (M).**  Rows are items, with verbs on existing seams.  Open the exact thread or run (`run.threadId` when set; S).  Acknowledge via `markRoutineRunSeen` and `acknowledgeAllAttention` (`src/state/store.tsx:2540-2559`; S).  Answer with the card's own options via `answerCard` (`:2701-2718`; M, partly unverified: `pendingApprovals` (`PendingApproval.tsx:35`) sees only loaded messages, and the phone scans only main threads, `ios/Sources/CompanionCore/Store.swift:209-218`).  Snooze waits for resurfacing state.
2. **Put A Strip, A Tray Title And A Landing Where The Operator Is (M).**  One selector feeds a sidebar-top strip ("2 need you, 1 failing, 3 working", each part a button), the tray title and top-five menu, notification click-through to the exact thread, and Start On.  The dock stays on unread until the owner decides.
3. **Stop Pinning Bot State On Apps, Then Rebuild The Grid On Honest Data (L).**  Stopgap (M): app badges only from `busyBotId` and thread-bound `appRef`.  Full: the per-(bot, room) index (#815).  No new arrangement mode before it.

## The Owner's Decision

The interruption budget.  What may reach you unasked: (a) only what is blocked on your answer, (b) plus failures that have not recovered, or (c) plus unread replies?  It sets the tray title, the notifications, the dock number, and whether the app opens on the queue.  I would take (a) for notifications and (b) for the strip and tray.
