# Candidate Arrangements: A Seed Menu For Q5

A design pass on Fri, Oct 9 at main `1deb1bc91`, written against the constraints in `01-evidence.md`.  This is a menu for the panel to argue over, not a decision.  Cites are repo-relative at `1deb1bc91`; "from code, not run" marks behavior traced in source but not executed.  The toggle numbers (T1 to T10) are the inventory in `01-evidence.md` § 4.

## 1. Candidate Modes

| | Simple | Fleet | Bot Homes | Threads | Command Center |
|---|---|---|---|---|---|
| Sidebar | Today's | Today's projects, header "Bots" | Homes under bots, titled by room | Rooms over threads, "Unfiled", no Bots section | Inherits |
| New threads | None | Any, App optional | One per bot per App; needs a folder | "New Thread in {Room}" | Inherits |
| Automation | Open thread | Open thread, plus an "Own Thread" option per routine | A stable main thread for each bot | As Fleet | Inherits |
| Landing | Start On | Start On | Start On | Start On (Kanban) | Overview |
| Model picker | Bot | Thread | Bot | Thread | Inherits |
| Matrix cell | The bot's one conversation, labelled "Member" | The App thread, else the current one | Opens or creates the home | A card per thread | Inherits |

### Simple (Keep As One Mode)

"Named bots with one conversation each, plus {rooms} that invited bots and you all write in."

- **Changes needed to make the card true:** hide the room "+", label matrix cells "Member", and gate `switchTask` in `openBotInApp` on the mode.
- **Stays the same:** everything else.
- **iOS:** none.
- **Strongest objection:** "one conversation" stays untrue until rollover, one-shot wakes, and the Mac tab bar respect it.

### Bots + Rooms (Split From Simple; Reject)

Simple would become bots only, and "Bots + Rooms" would be today's Simple.

- **What it would change:** hide the rooms section (`Sidebar.tsx:2903-2923`) and the App Deck (`App.tsx:413`).  No server toggle moves.
- **Strongest objection:** the data already does this.  With zero rooms, both disappear (`App.tsx:104`).  A split would be copy, not a mode.

### Fleet (#180 Mode 2)

"Named bots, each with as many threads as you like, nested under the bot.  {Rooms} can hold several threads.  Each thread can pick its own model."

- **What it changes:** it is today's `projects` behavior with two changes.  The header says "Bots" (`shared/conversation-mode.ts:40-52`).  Each thread gets its own model, by giving the header model picker its existing `onChange` path and sending the per-thread PATCH the server already honors (T8).
- **Automation:** separate automation threads become an "Own Thread" option on each routine, next to the existing one-shot option (`oneShotWake`, `routines.ts:118,218`).  It is never a mode-wide switch.
- **Stays the same:** every server gate and route.
- **iOS:** behavior is unchanged, because the wire still says `projects`.  The "Threads" label (`ios/Sources/CompanionCore/Models.swift:900-901`) needs the new field to change.
- **Strongest objection:** #180 defined Fleet by its separate automation threads, and #470 removed exactly that at the owner's request.  Turning lanes on would not even split existing automations, because `stampAutomationKey` never re-keys a thread (`server/store.ts:2315`).  Without lanes, Fleet is a rename plus a model picker.

### Bot Homes (Preset B; Preset C Folded In)

"Named bots, and each bot keeps one private thread in every {room} it belongs to, beside the {room}'s shared conversation.  Bots take turns."

- **Thread creation:** creating a thread requires an App and returns the existing home rather than making a second one.  Room extras stay off.  A room with no folder gets no homes.
- **Automation needs a stable main thread per bot:** `defaultThread` returns whichever thread is open (`index.ts:6795-6803`), so a schedule would run in the last home you viewed, in that App's folder.  From code, not run; today's projects has the same exposure.
- **iOS:** the legacy mirror says `projects`, so older phones offer a bot "+" (`ios/App/ThreadTabBar.swift:58-61`) and a room "New task" (`ios/App/ChatView.swift:901-906`).  The server's refusal copy must name the arrangement.
- **Preset C is policy, not an arrangement:** C is B plus `workspace: lease`.  `effectiveWorkspaceSettings` drops that axis (`workspace-settings.ts:140-148`), so by the module's own rule (`:57-59`) C cannot be offered.  Isolation belongs to T10's existing policy.
- **Strongest objection:** all of a bot's homes share one busy flag (`workspace-settings.ts:17-21`), and attention is tracked per bot, not per room (`src/lib/attention-index.ts:7-11`), so one working bot reads "Working" in every home until the #815 spec ships.  Homes also cannot be merged back into Simple.

### Threads (#180's Projects)

"Your {rooms} are folders of threads.  Start a thread in a {room}, pick its model, and the bot behind it stays in the background."

- **Sidebar:** room headers over each room's threads, plus every bot thread whose `appRef.id` matches.  Unbound threads go under "Unfiled".  The Bots section (`Sidebar.tsx:2924-2951`) goes away.
- **Overview:** Kanban needs one card per thread; today it builds one card per bot (`KanbanCommandCenter.tsx:111-130`).
- **Stays the same:** the records.
- **iOS:** the biggest cost, because the phone's list nests bot tasks only (`ios/App/ChatListView.swift:669-675`).
- **Strongest objection:** the bot is the execution unit, so hiding bots hides why thread B is waiting on thread A.
- **Naming:** renamed from Projects because "Projects" is also a terminology preset (`server/config.ts:510-512`).

### Command Center (#813's Withdrawn Matrix Layout)

"Open to the Fleet Matrix.  {Rooms} are the main axis; pick a cell to jump into a bot's work there."

- **What it changes:** client-only.  The landing view and the App Deck emphasis.
- **iOS:** has no overview to show.
- **Strongest objection:** it changes nothing at runtime.  As an arrangement it would sync a view preference to a phone that cannot show it.  In Simple, every cell also opens the same conversation.

### Axes And The Settings Card

- **Fan-out** (single, one per App, any) is the only axis the server enforces, so it is the real mode axis.
- **Roster** is label-only today, and with single fan-out it changes nothing, so it is not truly independent.
- **Start view** is fully independent and client-only.
- **Isolation** is policy.
- **Automation lanes and model scope** are per-routine and per-thread choices, valid whenever fan-out is not single.

Recommendation from the design pass: two controls.

- **Workspace Arrangement:** a radio of named options.  Simple and Fleet now.  Bot Homes after the #815 spec and the main-thread fix.  Threads only if the panel accepts hiding bots.
- **Start On:** Mac only (Last Conversation / Overview).

Do not expose the raw axes.  Most combinations mean nothing, which is why #813's first draft was withdrawn.

## 2. Overview And Arrangement

Three options: (i) independent of arrangement, as today; (ii) the defining feature of one arrangement; (iii) a separate Home setting.  The design pass recommends (iii): a Mac-local "Start On: Last Conversation / Overview", kept in localStorage beside `botfleet.matrix_view_mode` (`FleetMatrixView.tsx:43-61`).  It needs no schema change, no migration, and no iOS work.  Option (ii) is backwards: the overview's cells are only honest when fan-out supports them.

**Precondition (from code, not run): the overview closes itself.**  The effect at `App.tsx:121-137` clears it whenever `selectedId` is set.  `selectedId` is set to the first bot on load (`store.tsx:1310-1311`).  The effect's dependencies include `state.bots`, `state.groups`, and `selectedAppId` (`:137`), so any bot update closes it, and so does the "All" tab click itself when a room was selected (`:417-421`).  Board row `6689e3f3`.

Touch points:

- `App.tsx:103`: start `matrixOverviewActive` from Start On when rooms exist.
- `App.tsx:121-137`: close the overview only when `selectedId` actually changes (compare against a ref), and skip the change at launch from empty to the first bot.  Sidebar clicks and ⌘1–9 rely on this effect.  The App Deck and matrix handlers (`:422-439`, `:448-470`) already close it themselves.
- `App.tsx:104`: with no rooms, fall back to the last conversation.
- `AppDeck.tsx:107-120`: keep the All tab.
- `FleetMatrixView.tsx:197`: the grid ignores `filterAppId`; only Kanban receives it.
- iOS: no overview, so Start On is never synced or shown there.

## 3. Adding A Value Safely

Use a new key.  Do not add a `conversationMode` value, and do not reuse `fleet`, which `server/index.test.ts:514-517` fixes to mean projects.

| Reader | New `conversationMode` value | New key |
|---|---|---|
| Builds before #800 | Every setting lost | Dropped silently |
| #800 and later | Mode reads as Simple, plus a partial-config banner | Dropped silently |
| Every writer | Round-trips | Round-trips |

The schema is a non-strict `z.object` (`config.ts:300`).  The config lock promises that keys a writer does not touch, including a newer build's, round-trip unchanged (`electron/config-file-lock.mjs:578-580`).  #800 landed today, so assume every Mac and any rollback target is still pre-#800.

Steps:

1. **Shared helpers** in `shared/workspace-settings.ts`: `WORKSPACE_ARRANGEMENTS` (`simple`, `fleet`, `bot-homes`, `threads`) and `parseWorkspaceArrangement`; `defaultArrangementFor` (simple maps to simple; projects or fleet map to fleet); `legacyModeFor`, keyed off fan-out (today's `conversationModeFor` keys off roster, `:152-154`, which would derive preset B to `simple`).  `shared/conversation-mode.ts` keeps `STORED_CONVERSATION_MODES` frozen.
2. **Schema** at `server/config.ts:509`: add `workspaceArrangement: z.string().max(32).optional()`.  Use `z.string`, not `z.enum`, so no future value can fail validation.  Normalize it in `:738-770` and `:839-841`; add it to `AppConfig` (`:725`) and `ConfigPatch` (`:734-736`); write both keys at `:1747`.
3. **Reconcile on load:** if `legacyModeFor(arrangement)` disagrees with `parseConversationMode(conversationMode)`, `conversationMode` wins, because an older build or phone changed it.
4. **Route** `server/index.ts:15893-15907`: keep the same route, so the phone allowlist at `companion/src/routes.ts:235` needs no change.  A legacy-only PATCH that matches the derived value does nothing; any other legacy PATCH remaps the arrangement.  Always save both keys.
5. **Plumbing:** `configStatus` (`index.ts:9652`) keeps `conversationMode` as simple or projects and adds the new field; the client adds it at `store.tsx:574` and beside `getConversationMode` (`:680-682`), and in the frame list and copy (`:686,712`) or SSE config frames drop it; add it to `server/config-reload-keys.ts:20-43` and its test (`:39`), or a PUT rebuilds every provider; update the source-string check at `server/secret-persistence.test.ts:149`.
6. **Settings UI:** `SettingsModal.tsx:629-728` and `src/lib/settings-search.ts:37-45`, with stable titles.
7. **iOS:** `Models.swift:873-901` decodes the optional field (`ConfigStatus` has no custom decoder, so older builds ignore it); `ios/App/SettingsView.swift:174-193` lists the arrangements when the field is present.

Reuse `parseConversationMode`, `getConversationMode`, `resolveRoomLabels`, `getRoomTerminology`, and `resolveWorkspaceSettings`.

**A proof you can run on HEAD** (set `OMB_DATA_DIR`, `config.ts:1130`): write a config with `workspaceArrangement: "bot-homes"`, `conversationMode: "projects"`, and `terminology: "apps"`; it loads with no problem reported and keeps the terminology.  `saveConfig({terminology: "groups"})` leaves the new key on disk.  Control case: `conversationMode: "bot-homes"` records a `config-partial` fault naming `conversationMode`, and the mode reads as Simple.  Total loss of every setting is pre-#800 behavior, known from code only.

If the panel insists on a new `conversationMode` value, follow the updater precedent (`docs/rollouts/2026-09-22-updater-transition-bootstrap.md`): ship acceptance first, confirm every Mac has it and #800, and only then write the new value.  Even then, a rollback to a build older than #800 still wipes settings.

## 4. Copy Fixes That Are True Whatever Ships

- `shared/conversation-mode.ts:89`: "Named bots stay hidden" and "Each thread picks a model" are both false (`Sidebar.tsx:2924-2951`; T8).  So is the comment at `:5-11`.
- `src/lib/settings-search.ts:41`, "Projects hide named bots", and the iOS footer at `ios/App/SettingsView.swift:609`: same fix.
- iOS says "Workspace Layout" (`SettingsView.swift:188`); match the Mac's "Workspace Arrangement".
- The Mac titles the second option with the room plural (`SettingsModal.tsx:672`), while iOS, search, and the errors say "Projects".  Use one stable name.
- `index.ts:12772,14455` say "turn on Fleet or Projects", but there is no Fleet option.  Name the card instead.
- Mac only: "Keep Extra Threads Hidden" (`SettingsModal.tsx:712`) leaves the threads visible as tabs.  Either gate the tabs or say "Keep Them Out Of The Sidebar".
- "Room Chat" ignores terminology at `AppDeck.tsx:303` and `FleetMatrixView.tsx:210`.  `FleetMatrixView.tsx:114` says "software development workspaces".  `AppDeck.tsx:340`, "thread in {App}", is false in Simple.

Board row `20725f10` has a lane on the first five.

## 5. Verification Per Candidate

- **Every candidate:** `SettingsModal.test.tsx:34-57` and `src/lib/settings-search.test.ts` assert today's false copy word for word, so they change with it.  Extend `server/index.test.ts:501-517` for the new key and reconciliation.  Put the config proof in `server/config.test.ts`.
- **Simple:** extend `tests/e2e/task-app-context.spec.ts:328`: no room "+" appears, and a cell never switches into a hidden thread.
- **Fleet:** add `workspaceArrangement` to `mockServer` (`:65`, config response `:131`); assert the "Bots" header, and record the per-thread model PATCH the way the spec records `posts`.
- **Bot Homes:** server tests that an App is required and a repeat create returns the same home; `server/routines.test.ts` that a schedule lands on the stable main thread, not the last home viewed.
- **Threads:** per-thread cards in `kanban-command-center.visual.spec.ts`.
- **Start On:** an App-level Playwright test in the `task-app-context` style that pushes an SSE bot update after landing and asserts the overview stays open.  Fixture-mounted views cannot catch `App.tsx:121-137`.
- **Matrix:** `FleetMatrixViewVisualFixture.tsx` seeds no config.  Add `?arrangement=` to seed the config and App-bound threads, and extend `fleet-matrix-view.visual.spec.ts` for cell labels.
- **New sidebar fixture:** `?fixture=sidebar-arrangement&arrangement=…&density=full|icons`, added beside `src/main.tsx:169-192`.  Mount the real `Sidebar` through `StoreContext.Provider`, as the matrix fixture does.  Seed a Chief, three bots (one in a section, one archived), two rooms (one with two threads), a bot-to-bot chat, App-bound threads, and "Apps" terminology.  Pin collapsed rooms, collapsed sections, and section order (`Sidebar.tsx:2285-2287`), plus `Date.now`, or the baselines will flake.
