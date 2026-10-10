Lens: Refuter (CLAUDE seat, Claude sub-agent).

# What Holds, What Does Not, And What The Builder Got Right

Cites at `5aa17ff3e`, read from code, git history and the captures; nothing was run.  Not verified: R2's uncommitted lanes, R3's pixel arithmetic, R2's and R3's outside-product comparisons.

## Claim Checks

**R1**
- Sections carry behavior: **Holds with a caveat.**  One Chief per section (`server/store.ts:677-679`), an owner brief injected into members' turns (`server/section-context.ts:1-6`, `server/index.ts:6409`, `:8610`), Team Map groups by it (`src/lib/team-map.ts:45-57`).  Bots only: a room's `section` is still a heading (`server/store.ts:285-289`).  "The overview disowned the section" misreads `AppDeck.tsx:22-24`, which is #830's fix against inferring room membership from sections.
- The deck duplicates the sidebar: **Holds with a caveat.**  `Sidebar` gets no app prop (`App.tsx:405-411`), a chip is a plain `select` (`:417-426`), the orders differ (`AppDeck.tsx:57-60`, `Sidebar.tsx:2658`).  True of the room list only: typed per-room badges (`AppDeck.tsx:219-266`), the member-bot sub-bar (`:283-368`) and the app-to-bound-thread path (`App.tsx:146-153`) have no sidebar twin.
- A view click changes shared state: **Holds with a caveat: app-wide, predates the overview.**  The server broadcast (`server/index.ts:14556-14571`) and `defaultThread` following the active thread (`:6802-6808`) are real.  But sidebar thread rows (`Sidebar.tsx:553`), Routines "Open Task" (`RoutinesPage.tsx:571`), webhooks (`WebhooksPanel.tsx:357`) and notifications (`store.tsx:1174`) all `select` then `switchTask`, since August.  The matrix added an entry point, not the model.

**R2**
- The 10 Errors are error tails with no card: **Holds with a caveat.**  Client bots have no `hasError` (`store.tsx:646` is Infisical's), so an Error is `dead` or an `error:` tail (`attention-index.ts:168-171`).  Kanban files bots by `activity` alone (`KanbanCommandCenter.tsx:125-216`) and ranks dead 100, no-signal 95, waiting 90 first (`:381-384`); the capture's top cards are rank-80 Run Failed, so none is dead or waiting.  The bot's Standby or In Flight card hides the error.  "One bot counted ten times" is inference; "reads 1 Error after the pill lane" rests on code I could not see.
- Numbers disagree, controls are dead: **Holds.**  The Needs Action pill hides at zero (`FleetMatrixView.tsx:167`) beside "449 Needs Action" (`KanbanCommandCenter.tsx:457`), both in `kanban-command-center.webp`.  `statusKind` is never read (`:42`), so every attention card is amber (`:495-498`); verbs are static (`:543,607,663`); `handleCardClick` ignores `rawRun` (`:409-426`).
- No actionable surface outside the overview, badges never on the roster: **Half holds.**  The tray is Show, Settings, Quit (`electron/main.mjs:2317-2333`) and notifications carry no actions (`notify.ts:41`).  But roster rows show one error, needs-action or unread dot with a reason tooltip (`Sidebar.tsx:1879-1891`, `:1959-1975`, #844), the glyph R2 recommends; click-through to the exact thread exists (`store.tsx:1147-1175`); Team Map (#434, Aug 24) shows each bot's status (`team-map.ts:101-106`).  Room rows lack the dot (`Sidebar.tsx:1025`).

**R3**
- ⌘1 and ⌘2 clash with the View menu: **Holds with a caveat.**  `electron/main.mjs:2198,2203` against `src/App.tsx:165`.  Which side wins is undetermined.  It is not new: `docs/audits/2026-10-07-review/R5-ux-frontend.md:95-98` (UX-8, P2) found it two days ago; row `97877bcc` (and palette row `e8a7dfa9`) appeared only at 4:10pm today, at P3.
- Nothing restores the last conversation: **Holds.**  No selection key exists in the renderer's storage, hydrate falls back to `bots[0]` (`store.tsx:1308-1311`), and `createBot` unshifts (`server/store.ts:1960`), so launch lands on the newest bot.  Electron saves window bounds only (`electron/window-state.cjs`).
- The phone's Updates is the model: **Holds.**  Needs you first, answered in place (`ios/App/Updates.swift:1-6`, `UpdatesSheet.swift:1-5`).  It is an on-demand sheet, so it supports Needs You as the overview's default tab, not as a landing view.

**R4**
- Five defects in `workspace-settings.ts`: **Holds with a caveat.**  Roster "honored" yet label-only (`:61`), `per-room` cannot tell Fleet from Bot Homes (`:108`), no preset equals projects (`:88-92`), and `conversationModeFor` keys off roster (`:152-154`, already planned in 02 § 3) all hold.  The fifth, "four axes, three defined", is a doc nit: terminology is excluded on purpose (`:28-29`).  The module is unwired (imported only by `server/workspace-settings.test.ts:18`), so these are design gaps, which R4 itself frames as internal.
- Merge All Threads fails silently: **Holds.**  `server/store.ts:1578-1586` throws a 409 before the route saves the mode (`server/index.ts:15943-15946`); `SettingsModal.tsx:658` is a bare `catch {}`.  Triggered when extra threads carry different App bindings.
- #814 said the room word must never gate layout, then #813 titled the option with it: **Holds.**  Merged 4:03pm and 9:33pm, Oct 3 (`gh pr view`); `SettingsModal.tsx:680`.

## The Builder's Case

Before #827 the Mac had Team Map (one status per bot, by section) but no rooms-by-bots view and no aggregate counts.  AG shipped both as the owner's "Option C" (effort log only; no design document).  Chat stayed first: the landing draft was reversed seven minutes later (`043f0828e`, `e6c75eaeb`), and the composer is `absolute bottom-0` (`ChatView.tsx:1803-1806`), so the strip never covers it.  Typed badges follow the #815 spec, #844 carried them to roster rows, the board's ranking is the spec's own rule (`KanbanCommandCenter.tsx:381-386`), and bot-global counting is disclosed in the module header (`attention-index.ts:7-11`).  The self-dismissal is #854's regression: the effect depended on `[state.selectedId]` through #835 and #844, and `git log -S` finds the widened list first in `ed522da6c`.

Survive: counts sum bot-global state per room against the plan's "distinct bots" rule and slice order (`docs/plans/2026-10-03-paseo-adoption.md:49,54-60`); the board ignores acknowledgement (`seenAt` unread) and floods; the matrix never reads the arrangement.  The #851 squash text, "app-scoping is live", is false: the filter is null whenever the overview shows (`App.tsx:420,465`).  Overstated: "the deck duplicates the sidebar" (room list only) and "badges never on the roster".

## Where The Panel Agrees And Splits

| | R1 | R2 | R3 | R4 | Call |
|---|---|---|---|---|---|
| Simple | keep | keep | keep | keep | Settled |
| Bots + Rooms, Threads | reject | reject, defer | reject | silent, not now | Settled |
| Fleet | rename | fine | accept | accept | Name open |
| Bot Homes | after #815 | defer | defer | after #815 | Settled |
| Command Center | reject | Start On | reject | reject | Settled |
| Start On | yes | + Needs You | own card | drop | Split |
| New control | App scope | none | none | named radio | Split |
| Overview a destination | yes | yes | yes | silent | Settled |
| Strip above chats | no | shrink | no | fine | Split |
| Needs You default | later | yes | yes | none | Split |

Settled: keep Simple and make it true, no new runtime arrangement before per-(bot, room) attention, one definition per number.  Open: default tab, restore-only versus Start On (only R3 and R4 state a default), the strip's fate, App scope versus radio, the Fleet name.

## Claims That Could Mislead The Owner

1. **"The deck duplicates the sidebar, so retire it."**  Three papers agree, but the badges, sub-bar and thread path exist nowhere else.  Fix the numbers and the placement first.
2. **R2's "typed badges never on the roster."**  R2 cites the per-row icon in Q2, then recommends adding one in Q4; #844 shipped it for bot rows.  The tray and notification-action points stand, and of recommendation 2's parts only click-through is built.
3. **R2's "worse than the roster."**  It leans on pill and card defects that lanes `710979ea` and `fbd2be5e` already change.  Judge the design after those land.

## Q1 To Q6 Where I Dissent

Concur with R1 on Q1 and Q4 (but rooms stay fileable under sections, `server/store.ts:285-289`), and with R4 on Q5: Fleet rename and Simple true now, Bot Homes after #815.  The overview does not make Simple moot.
- **Q2:** concur on removing the strip from Routines and Team Map (`App.tsx:413` sits outside the view switch).  Against R1, every destination row lives in the sidebar footer (`Sidebar.tsx:3084-3130`), not the top.
- **Q3:** the default is Kanban's Attention Queue, repaired, not a new list.  Do not merge the draft `NeedsYouList` (`092d8fc61`): it links `/?thread=`, which nothing reads.
- **Q6:** add the dead card verbs and the swallowed 409.  Loading transcripts by thread is L and not a #827 defect.

## Ranked Recommendations

1. **Repair the Attention Queue and make it the overview's default (M).**  Error-tail bots enter, `seenAt` honored (`routine-attention.ts:27-28`), latest run per routine, open `run.threadId`, real verbs, pill equals list length.  Inline answers are L: `answerCard` reads loaded `bot.messages` (`store.tsx:2701-2703`).
2. **A stable door, and restore the last conversation (M).**  Selection-change ref in `App.tsx:122-137`, deck only over chat and overview, footer row, palette verb; persisting `selectedId` alone is S.
3. **Make Simple true, single-source the copy, add no mode (M).**  Gate `switchTask`, the room "+" and tabs in Simple, label cells "Member", show the 409.

## The Owner's Decision

When a bot is waiting on you at launch, should BotFleet open on it, or on a chat?  Today it opens on the newest bot's chat: chat-first, but not the last conversation.  Opening on the waiting item is the operator default, honest only after recommendation 1; restoring the last conversation is the cheap middle.
