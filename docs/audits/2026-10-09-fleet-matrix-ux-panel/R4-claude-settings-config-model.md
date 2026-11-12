Lens: Settings And Config Model (CLAUDE seat, Claude sub-agent).

# The Arrangement Is A Policy, The Overview Is A View

Verified at `15263c2b6` (this worktree adds only panel docs on top).  "Unverified" or "not run" marks what I did not read or execute.

## Q1

**Verdict:** Better as a status glance, worse as a navigator in Simple, because it was built without reading the config model.

The plan told the matrix to "Use the shared settings resolver" (`docs/plans/2026-10-03-paseo-adoption.md:55`).  It reads no arrangement value: zero references in `src/App.tsx`, `FleetMatrixView.tsx`, `AppDeck.tsx`, `KanbanCommandCenter.tsx` or `attention-index.ts`.  With an App-bound thread, a cell lands on it (`src/lib/task-app-thread.ts:20-21`).  In Simple, where bound threads cannot be created, every cell in a bot's column opens the same conversation and shows bot-global state (`FleetMatrixView.tsx:338-341`, `src/lib/attention-index.ts:7-11`).

## Q2

**Verdict:** The top of the pane is an acceptable home for the deck.  Whether the overview is the landing view is per-device state, never an arrangement.

View state already persists per device (`FleetMatrixView.tsx:45,57`); the arrangement syncs to a phone with no overview.  Any "open on the overview" behavior is false today: hydrate selects the first bot in store order (`src/state/store.tsx:1311`), which `createBot` fills from the front (`server/store.ts:1960`), and the effect at `src/App.tsx:122-125` then closes the overview (from code, not run).  Nothing about landing may ship before `6689e3f3`.

## Q3

**Verdict:** Keep both views, and make every cell name what it opens.

Kanban builds one card per bot plus run cards (`KanbanCommandCenter.tsx:111-120`), which fits Simple.  The grid is honest only where a cell has its own thread, so a cell should say "Thread" where an App-bound thread exists and "Member" elsewhere, which in Simple is every cell.  First-run default: Kanban in Simple once `fbd2be5e` stops the flood, the Grid in Fleet; a stored choice wins.

## Q4

**Verdict:** The bot stays the primary axis in every arrangement that can ship this quarter.  Terminology renames nouns everywhere and names no mode.

Records are identical in every mode (`shared/conversation-mode.ts:1-2`), App membership is `memberIds` only (`attention-index.ts:14`), and the bot is the execution unit (`shared/workspace-settings.ts:17-21`).  Terminology fails both ways: it renames a mode (`src/components/SettingsModal.tsx:672`), yet misses the nouns in "Channel Turns" (`SettingsModal.tsx:1377-1378`), "Room Chat" (`AppDeck.tsx:303`, `FleetMatrixView.tsx:210`) and "one conversation per channel" (`server/index.ts:12772`).  Deck versus sidebar duplication I leave to Information Architecture.

## Q5

**Verdict:** The overview does not make the setting moot; it makes itself dishonest in Simple.  Rename one option now, make Simple true, and hold every new behavior for the per-room attention spec.  I add no arrangement of my own.

**The premise.**  What `projects` changes is server policy, the 409s at `server/index.ts:12770-12774` and `:14453-14457`.  A view cannot make a refusal moot.  The overview does make the card's copy moot, because the deck already treats rooms as categories in both modes.

**One radio of named arrangements, never axes.**  `shared/workspace-settings.ts` is unfit to build a UI on as written:

- `HONORED_AXES.roster` is `true` (`:60-61`), yet the sidebar lists bots in both modes; projects only retitles the header "Threads" (`src/components/Sidebar.tsx:2926`, `conversation-mode.ts:45-49`).  Roster is a label posing as an axis.
- `legacyAxesFor("projects")` says `fanOut: "per-room"` (`:108`), but projects allows any number of threads with an optional App (`server/index.ts:14461`).  The axes cannot tell Fleet ("any") from Bot Homes ("one per App, binding required").
- No preset equals today's projects (`:86-93` against `:106-110`), so a preset radio would select nothing for every projects install.
- `conversationModeFor` keys off roster (`:152-154`), so preset B would derive to `simple`, and the server would refuse its threads.
- It promises four axes (`:1`) and defines three (`:51-55`).

Keep it as an internal resolver after those fixes.  Drop the proposed Start On control: restore the last view per device, which needs zero controls, once selection persists and `6689e3f3` lands.

**Every sentence true, written once.**  The copy has forked four ways: the Mac card, the phone (`ios/App/SettingsView.swift:185,188,609`), settings search (`src/lib/settings-search.ts:41`), and refusals naming a "Fleet" option that does not exist (`server/index.ts:14455`).  Resolve titles and descriptions on the server, as `roomLabels` already is (`shared/terminology.ts:11-12`), and back each sentence with a test, as `server/index.test.ts:505-509` backs "one conversation per bot".  Each sentence names one behavior that changes, so the description is the preview.  Proposed, true once Simple is fixed:

- **Card:** "Choose how many conversations each bot can hold.  It applies on this computer and on your phone."
- **Simple:** "Each bot keeps one conversation with you.  {Rooms} are shared conversations that you and the bots you invite all write in."
- **Fleet:** "Each bot can hold as many threads as you like, nested under it in the sidebar.  {Rooms} can hold several threads too."

Add "Each thread can use its own model" only when a client sends the per-task `modelSelection` the server honors (`server/index.ts:14583-14607`).  Neither the Mac (`src/state/store.tsx:2878-2933`) nor the phone (`ios/Sources/CompanionCore/Client.swift:1447-1501`) sends it.

**Terminology.**  Stable titles, with the room word only as a noun inside descriptions.  #814 merged at 4:03pm on Oct 3 saying the room word "must never gate layout"; #813 merged at 9:33pm and titled the option with it (`SettingsModal.tsx:672`).  With "Apps" chosen, the refusal says "turn on Fleet or Projects" while the card offers Simple and Apps, and the phone offers "Projects" in two adjacent pickers (`SettingsView.swift:185,214`).

**The candidates.**

| Candidate | Lies today? | Minimum before Settings |
|---|---|---|
| Simple | Yes: Mac shows every tab (`src/components/ThreadTabs.tsx:252-254`; the phone hides them, `ios/App/ChatView.swift:750-753`), the room "+" is live (`ThreadTabs.tsx:290`), cells switch into hidden threads (`src/App.tsx:146-153`), rollover and one-shot runs add threads ungated (`server/routines.ts:1396-1417,1462-1478`) | Gate the first three; route rollover and one-shot output to the visible conversation; cells say "Member" |
| Fleet | Only if it claims per-thread models | Rename, header "Bots"; disk stays `projects` |
| Bot Homes | Yes: no home uniqueness, bot-global attention, automation lands in the open thread (`server/index.ts:6795-6803`), merge-back refuses App-bound threads (`server/store.ts:1578-1586`) | #815, server-enforced one home per App, a stable main thread, a merge path |
| Threads | Yes: nothing hides bots | A thread roster on Mac and phone, if ever |
| Command Center | Yes on the phone, a choice that does nothing | Reject; it is device view state |

**Migration.**  I endorse the new key, the fan-out mirror, the same route, and writing both keys every time.  Six corrections:

1. Add the key with the first behavior that needs it (Bot Homes).  The Fleet rename needs no storage change.
2. Free string on read, yes; on write, no.  Lenient read, strict write, as Zulip already does (`server/config.ts:530-531`): a stored value never fails (no `.max(32)` path to a partial-config banner), the route answers 400 to an unknown id, and `PATCH /api/config` omits the key, as it omits `instances` (`:532-534`).
3. Reconcile in memory on load; `conversationMode` wins only when present.
4. An unknown value runs on its mirror, and the card says so: "{Arrangement} was set by a newer version of BotFleet.  This version runs it as {Simple or Fleet}."
5. A rolled-back build can break any arrangement stricter than its mirror, so Bot Homes must tolerate extra threads.
6. An old phone writes only the legacy key, so Simple and back lands on Fleet, not Bot Homes; document it.

Writers since #258 merge into the raw file (`server/config.ts:1665-1666`, `electron/config-file-lock.mjs:578-580`).  Earlier writers are unverified; the worst case is the mirror falling back to Fleet.

**Within a week:** Fleet as a rename, and Simple made true.  Bot Homes waits for #815.

## Q6

**Verdict:** Fix the copy and the silent failure whatever the design outcome.

- "Each thread picks a model.  Named bots stay hidden." (`shared/conversation-mode.ts:89`), pinned by `SettingsModal.test.tsx:51-53`, repeated at `settings-search.ts:41` and `SettingsView.swift:609`.
- "Merge All Threads" fails silently.  The store refuses App-bound threads with a 409 (`server/store.ts:1578-1586`) before the mode is saved (`server/index.ts:15901-15903`), and the card swallows it (`SettingsModal.tsx:650`).  The person believes they switched.
- "Grok-style" in shipped copy (`SettingsModal.tsx:666`, `settings-search.ts:41`) means nothing to a newcomer, and the default subtitle invents "channels mode" (`SettingsModal.test.tsx:47`).
- "Keep Extra Threads Hidden" leaves them visible as Mac tabs (`SettingsModal.tsx:712`, `ThreadTabs.tsx:252-254`).

## Ranked Recommendations

1. **Retitle and tell the truth (S).**  Stable titles Simple and Fleet, true copy defined once on the server for Mac, phone, search and refusals, the "Bots" header in Fleet, and a visible merge error.  No storage change.
2. **Make Simple true, and the overview honest in it (M).**  Hide Mac tabs, gate the room "+", gate `switchTask` in `openBotInApp`, route rollover and one-shot output to the visible conversation, and make cells name what they open.  Then restore the last view per device, after `6689e3f3`.
3. **Bot Homes after #815 (L).**  Fix `workspace-settings.ts` first, then the new key with lenient read and strict write, the newer-version notice, and rollback tolerance.

## The Owner's Decision

Is Simple a first-class way to use BotFleet, with an overview that shows membership and status only, or should new installs start in Fleet so per-App threads are the normal way to work?  Either way, an install with nothing on disk keeps reading as Simple (`shared/conversation-mode.ts:16,24`); a new default is written explicitly at first run.
