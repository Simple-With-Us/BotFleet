# R5 Report: User Experience, Intuitiveness and Frontend Performance (prefix UX)

Base: origin/main `d2bc60257`.  All counts below come from grep or small node scans and are heuristics unless noted.  I could not run the UI, so render-cost claims are inferred from code and marked as such.

## Information Architecture Map

**Navigation.**
- Sidebar roster with sections, rooms, search and density modes (`Sidebar.tsx`, 3,314 lines).
- Sidebar footer: Teach a Skill, Tasks and Routines, Connected Apps via Composio, profile row, phone, update, Report a Problem, and a gear (`Sidebar.tsx:3085-3182`).
- Team Map, Fleet Matrix and Kanban.  Matrix and Kanban are reachable only through `AppDeck`, which renders only when a non-DM room exists (`App.tsx:100`, `:407`).
- Right rails: per-bot Settings, Computer, Inspector, and Group Settings.
- App Settings modal with 10 tabs: General, Connections, Remote, Engines, Models, Phone, Computers, Usage, Observability, Secrets (`SettingsNav.tsx:19-30`).
- Settings search indexes 41 cards (`settings-search.ts`).  Per section: General 11, Connections 7, Computers 7, Usage 6, Engines 3, Observability 3, and 1 each for Models, Remote, Phone and Secrets.
- Form controls in the settings-related files: at least 126 by a crude grep.  This is a floor, because segmented controls are built from buttons.
- The per-bot Settings panel adds about 15 more cards (`SettingsPanel.tsx`).

**Clicks for common tasks.**

| Task | Path | Verdict |
|---|---|---|
| Create a bot | ⌘N, or + then New Bot (`Sidebar.tsx:2790-2802`) | Good |
| Add a bot to a room | Open room, Members (`GroupView.tsx:1374`), pick.  The bot context menu has no "Add to room" (`Sidebar.tsx:1700-1790`). | 3 clicks |
| Why is a bot stuck or failed | The roster shows one truncated line, `Error: <raw text>` (`Sidebar.tsx:1829-1833`).  Detail needs the chat, then Trajectory or Inspector (overflow menu). | 2 to 3 clicks, raw text |
| What is a bot doing now | Roster status line plus chat presence | 0 to 1 click |
| Approve a permission | Open that bot's chat, click Allow (`PendingApproval.tsx:141-193`) | No queue, no shortcut |
| See spend | Gear, then Usage tab.  Per-thread footer chips also exist. | 2 clicks, fine |
| See quota exhaustion | Only inside the ModelPicker (`ModelPicker.tsx:227`, `:821`) and Settings | Hidden |

---

## Findings

### UX-1 [P1] [NEW] Typed provider errors are discarded, so the UI shows raw engine text and guesses recovery by substring
- Evidence:
  - The server classifies failures into `ProviderErrorCode` (`server/contracts.ts:19-25`).  For example, 402 and 429 map to `quota_or_region_restriction` and 401 to `invalid_credentials` (`server/drivers/chat-completions/errors.ts:30-36`).
  - The event that reaches the transcript is `{ type: "runtime.error"; message; setup? }` (`contracts.ts:230`).  The code is dropped, and `server/index.ts:3962` stores `error: ${sanitized.slice(0, 8000)}`.
  - `ErrorRow` prints the raw message (`ErrorRow.tsx:224`).  It then chooses buttons by `message.includes(...)`: "stall watchdog timeout", "git checkpoint missing", and others (`:231-282`).
  - `isProviderError` matches the substrings "provider", "api key", "rate limit" and "model" (`:46-54`).  Any message that mentions "model" gets Switch Model and Add API Key.  A rate limit gets the same two buttons and no reset time.
  - The "Retry With Fallback" button calls the same `onRetry` as plain Retry (`ChatView.tsx:964`, `onRegenerate`).  Whether fallback happens is a server policy the button does not select.
  - `productErrorHeadline` exists (`product-error.ts:39`) but is used only by settings and fetch surfaces, never by chat or roster errors.
  - The sidebar derives error state from the last message (`Sidebar.tsx:1817`), so one later message clears the red state.
- Impact: Rate-limited, quota-exhausted, auth-expired and upstream-outage all look like the same red blob.  A power user with 10 bots on subscription quotas gets no state to act on or filter.
- Recommendation: Carry `code`, `retryAfter` and `resetsAt` on the transcript tool record.  Render one plain-language headline from a code table, with the raw text behind a disclosure.  Pick buttons by code.  Persist error state on the bot record, not the last message.  (Effort: M)

### UX-2 [P1] [NEW] No fleet-wide "needs you" queue; approvals are per-chat, mouse-only, and desktop notifications cannot act
- Evidence:
  - An approval takes over the composer of that bot's own chat (`Composer.tsx:716-735`).  `PendingApprovalActions` has click handlers only, with no key handling (`PendingApproval.tsx:141-193`).  "Approve All" is per thread.
  - The cross-bot attention view (`attention-index.ts`) is consumed only by `AppDeck` and `FleetMatrixView`, both gated on a non-DM room existing (`App.tsx:100`, `:407`).  A user with only direct bots has no aggregate.
  - Desktop notifications are plain `new Notification(...)` with no actions, and are suppressed while the window has focus (`notify.ts:40-53`).  So a bot waiting in a chat you are not viewing produces nothing except a small roster dot.
  - iOS already has Approve and Deny directly in the notification (`ios/App/Notifications.swift:19-31`, `:176-179`), so the phone has a faster approval path than the desktop.
- Impact: This is the power user's main loop.  With about 10 bots, finding and answering waiting bots costs a hunt through the roster.
- Recommendation: Add a persistent "Needs You" list (waiting approvals and questions, errors, dead bots) in the sidebar, independent of rooms.  Add shortcuts for Allow Once and Deny on the focused request, and a "next waiting bot" shortcut.  Add notification actions on Electron.  (Effort: M)

### UX-3 [P1] [STILL-OPEN R1 + R4] One malformed entity in a bot's last message blanks the app, and it re-crashes on relaunch
- Evidence:
  - `plain-preview.ts:50-58` still calls `String.fromCodePoint(code)` guarded only by `Number.isFinite`.  I reproduced the throw: `RangeError Invalid code point 1114112`.
  - The sidebar calls `plainPreview(last.text)` while rendering every idle row (`Sidebar.tsx:314`, `:340`).
  - There is no app-level boundary.  `main.tsx` renders `<StrictMode><App/></StrictMode>` bare.  `SentryErrorBoundary` is defined (`sentry.ts:223`) but mounted nowhere.  The only boundary is `MessageBoundary` around markdown (`ChatView.tsx:177`).
- Impact: Any bot text containing a numeric entity above U+10FFFF (scraped HTML, for example) makes the window blank.  The message is persisted, so relaunch crashes again.  I am escalating the prior P2 to P1 because there is no in-app recovery.
- Recommendation: Bound the code point to 0 through 0x10FFFF, with a test.  Mount a top-level boundary with a Reload button and per-region boundaries (sidebar, chat).  (Effort: S)

### UX-4 [P2] [NEW] The status model is too thin and partly wrong
- Evidence:
  - The server's `dead` activity means a setup failure (`server/index.ts:3963-3968`).  The roster calls it "Process terminated" with no cause or action (`Sidebar.tsx:1830-1832`).
  - `no-signal` is typed (`store.tsx:346`) but handled only in Kanban and Matrix (`KanbanCommandCenter.tsx:161`), not in the roster.
  - There is no rate-limited, quota-exhausted or "running on fallback" state.  `activeModelSelection` swaps the tiny provider mark (`Sidebar.tsx:1898-1907`), with no label.
  - `stateForBot` picks an idle bot's mascot expression from keywords in its name, title and description (`mascot.ts:229-231`).  A bot described as a "coder" shows the "working" pose while idle.
  - Status dots are 8px, color-keyed, and carry `aria-label` on a bare `<span>` (`Sidebar.tsx:1935-1951`), which assistive tech ignores.
- Impact: The roster cannot answer "which of my bots is unhealthy and why".
- Recommendation: One bot-status enum with a label, icon and recovery action, used by the roster, chat header, matrix and iOS.  Drop keyword-derived expressions when idle.  (Effort: M)

### UX-5 [P2] [STILL-OPEN R8 + R12] Every non-token frame re-renders about 98 `useStore()` call sites, and the roster rebuilds per message
- Evidence:
  - Token streaming is fixed: deltas are rAF-batched into a separate `StreamContext` (`store.tsx:2315-2386`, `:3193-3207`).
  - Everything else still flows through one context whose value changes with `state` (`store.tsx:3338-3345`).  There are 98 `useStore()` sites in 55 files, and only 10 `memo(...)` components in `src`.  Roster rows are not among them.
  - `MessagesList` is memoized but calls `useStore()` itself (`ChatView.tsx:857`, `:891`).
  - The roster sort memo is keyed on `state.bots` (`Sidebar.tsx:2661`), which changes identity on every `messageAdded`.  The comparator rebuilds a Map per side through `visibleMessages` (`store.tsx:408-420`, `:435-441`).
  - The `messageAdded` reducer copies the whole message array and runs an O(n) dedupe (`store.tsx:1564-1593`).
- Impact: With many bots running tools, each tool chip triggers a full-tree render and a re-sort.  Unprofiled; inferred from structure.
- Recommendation: Move to selector subscriptions (`useSyncExternalStore` with per-bot slices) and memoized rows.  Precompute last-activity and preview on the bot record.  (Effort: L)

### UX-6 [P2] [NEW] During a stream, the whole chat chrome including the composer re-renders every frame
- Evidence:
  - `ChatView` calls `useStreaming()` at the top level (`ChatView.tsx:1226`), so it re-renders on each animation frame.
  - `Composer` is a plain function component (`Composer.tsx:140`) receiving fresh inline arrows (`ChatView.tsx:1879-1886`).  The header, `ModelPicker`, `JobsMenu` and `ThreadStatsBar` re-render too.  Only `MessagesList` bails out.
  - `GroupView` does the same at `:990`.
- Impact: Possible typing lag while a bot streams.  Inferred, not profiled.
- Recommendation: Move the streaming read into a small tail component.  Memoize `Composer` and stabilize its callbacks.  (Effort: S)

### UX-7 [P2] [STILL-OPEN R2] No visible disconnect or reconnect state when bots are loaded
- Evidence: `es.onerror` only dispatches `connected: false` (`store.tsx:3067`).  `state.connected` is read for the zero-bot placeholder, `noEngines` and `PluginsPanel`, never for a banner (`App.tsx:140`, `:498`).
- Impact: If the harness restarts or the stream dies, stale bots stay on screen with no cue.  The prior audit found the attached-mode stream may not recover at all.
- Recommendation: Add a "Reconnecting" banner driven by `connected`, plus a keepalive watchdog.  (Effort: S)

### UX-8 [P2] [NEW] Shortcut collisions between the Electron menu and the renderer
- Evidence: The renderer claims ⌘1 through ⌘9 (jump to bot) and ⌘N (`App.tsx:151-170`).  The menu binds ⌘1 to Chat and Threads, ⌘2 to Automations and Routines, ⌘N to New Bot, and ⌘T (`electron/main.mjs:2130-2192`).
- Impact: Either bot 1 and 2 are unreachable by shortcut, or the menu's ⌘1 and ⌘2 are dead.  I could not determine which side wins without a live keypress test.
- Recommendation: Pick one owner per chord, set `registerAccelerator: false` where the renderer handles it, and print the shortcut hints in the UI.  (Effort: S)

### UX-9 [P2] [NEW] ⌘K is a switcher, not a command palette
- Evidence: Entries are only bots, rooms and message hits (`CommandPalette.tsx:12-16`, `:96-103`).  There are no actions for Settings, Usage, Routines, New Bot, pending approvals or error bots.
- Impact: Every action beyond jump-to-chat takes mouse travel.
- Recommendation: Add action entries and a "Needs You" group.  (Effort: M)

### UX-10 [P2] [NEW; includes STILL-OPEN P13 and R18] First run asks for an email before showing value, then dead-ends
- Evidence:
  - Step 0 is name and email (`Onboarding.tsx:176-187`).  The copy promises "when big things ship"; the tracking is not mentioned.
  - `initAnalytics()` runs on mount, before the gate (`App.tsx:583-585`).
  - The engines step has no `res.ok` check, so a 503 during harness boot shows an empty list (`Onboarding.tsx:141-143`).
  - There is no first-bot step.  The overlay has no dialog role, focus containment or Escape, so the app underneath stays tabbable.
  - With zero bots, the main area shows a spinner beside "No bots yet" and no action (`App.tsx:495-498`).
  - `NoEngines.tsx` is genuinely good: it explains the state and offers a recheck.
- Impact: A new user hits a form first and sometimes an empty panel.
- Recommendation: Engines first, then optional profile.  Defer analytics until after the gate.  Retry the instances fetch with an explicit empty state.  Replace the zero-bot spinner with a "Create Your First Bot" button.  (Effort: S to M)

### UX-11 [P2] [NEW] Settings information architecture is split and redundant
- Evidence:
  - Connections and Secrets share the `KeyRound` icon (`SettingsNav.tsx:21`, `:28`).  Connections mixes API keys, voice, Composio, webhook ingress, RAG and Linq (7 cards).  Secrets is the Infisical vault view.
  - Engines and Models are separate tabs (`:25-26`).
  - "Default Bot Settings" ships described as "Legacy defaults for newly created bots" (`settings-search.ts:332-333`).
  - A vendor name sits in primary navigation: "Connected Apps via Composio" (`Sidebar.tsx:3125-3131`).
  - The profile row and the gear both open App Settings (`Sidebar.tsx:3147`, `:3179`).
  - Observability is a top-level tab for what is a diagnostics toggle.
- Impact: Hard for a new user to know where a key or an engine setting lives.
- Recommendation: See Course Corrections 3.  (Effort: M)

### UX-12 [P2] [NEW] The "bot, not agent" rule leaks, and the guard test cannot see it
- Evidence:
  - Web: "Cursor's coding agent" (`engine-capabilities.tsx:331`) and "mounts the agents and local-computer channels" (`:1059`, `:1065`).  `ui-copy.test.ts` scans only JSX text and three attributes (`ui-copy.test.ts:30-40`), not object-literal strings.
  - iOS: 30 user-facing strings contain "agent": 17 in `AgentProfileView.swift`, 9 in `TasksRoutinesView.swift`, plus a few others.  Examples: "Choose an agent", "What should the agent do?", "Deleted agent" (`TasksRoutinesView.swift:143`, `:242-246`).  Nothing in `ios/` is scanned.
- Impact: Violates the owner's copy rule on both platforms.
- Recommendation: Extend the copy test to string literals in `src/lib` and add an iOS check.  Fix the 33 strings.  (Effort: S)

### UX-13 [P2] [STILL-OPEN R20] Time display breaks the owner's clock rule
- Evidence:
  - `timeZoneName: "short"` renders CST or CDT at five sites: `PluginsPanel.tsx:213`, `UsageMonitorQuotaGrid.tsx:31`, `BotSkillsPanel.tsx:85`, `RoutinesPage.tsx:482`, `qdrant-status.ts:60`.
  - About ten `toLocaleTimeString([], …)` calls follow the OS locale, so a 24-hour system setting shows 24-hour times (for example `store.tsx:3356`, `ToolLine.tsx:101`).
  - Zone policy is mixed: some places pin `America/Chicago`, others use local time.  Two spots call `toLocaleString()` with no options (`TeamMapPage.tsx:263`, `SecretsSection.tsx:258`).
- Impact: Inconsistent, and not the required "3:15am" style.
- Recommendation: One `formatClock` helper (12-hour, lowercase am/pm, no zone label) used everywhere.  (Effort: S)

### UX-14 [P2] [STILL-OPEN P7] Default theme follows the OS, and contrast checks are not enforced
- Evidence:
  - `getDefaultSkin()` returns `"system"` (`skins.ts:99-101`), and `index.html:13-16` resolves it from `prefers-color-scheme`.  The owner rule is Light by default.
  - `check-skin-contrast.mjs` exits 1.  Six of ten skins fail, including Studio (hairline 1.36:1) and Nordic (warning on card 2.15:1, danger on card 3.46:1).  The advisory Midnight row shows accent-ink on accent at 3.65:1 and danger-ink on danger at 3.10:1.
  - Only `check:contrast` is in `package.json:25`.  No workflow references either script.  `check-contrast.mjs` still lists three KNOWN pairs that now pass.
- Impact: The default is not what the owner specified, and contrast regressions ship silently.
- Recommendation: Make Studio the first-visit default, fix or retire failing skins, and run both scripts in CI.  (Effort: S)

### UX-15 [P2] [NEW] Accessibility gaps in the roster, overlays and rails
- Evidence:
  - Roster rows are `role="button"` divs (`Sidebar.tsx:2072-2090`).  The 3,300-line file has no `aria-current`, `aria-selected` or `aria-pressed`, and no arrow-key navigation.
  - Status dots are spans with `aria-label` and no role (UX-4).
  - `App.tsx:152` says every panel closes on Escape, but `SettingsPanel`, `ComputerPanel` and `InspectorPanel` have no Escape handler (none of the three appears in a grep for `Escape`).
  - The onboarding overlay has no dialog semantics (UX-10).
  - Positive: icon-button naming is good.  I eyeballed three unnamed close buttons out of 623 (`RoutinesPage.tsx:355`, `:604`, `:687`).  Modals such as Settings and Plugins do trap Tab (`"Tab"` handlers).
- Impact: A screen-reader or keyboard user cannot tell which bot is selected or unhealthy.
- Recommendation: Expose selection and status on rows with real roles.  Add Escape to the rails.  Name the three close buttons.  (Effort: S to M)

### UX-16 [P2] [NEW] The iOS companion lags the desktop on status and accessibility
- Evidence:
  - A chat row shows only a spinner and one "Waiting on you" pill (`ChatListView.swift:850-870`).  There is no approval-versus-question-versus-teammate split, no working location, and no dead or error state.  Desktop has all four wait reasons (`sidebar-activity.ts`).
  - 150 fixed-size `.font(.system(size:))` calls in `ios/App`, so text does not follow Dynamic Type.
  - Positives: notification Approve and Deny (UX-2), and a clear Mac-offline banner (`ChatListView.swift:963-1000`).
- Impact: The phone cannot show why a bot needs attention.
- Recommendation: Share the status enum from UX-4 with iOS.  Use text styles instead of fixed sizes.  (Effort: M)

### UX-17 [P3] [STILL-OPEN R21 + R22] Sentence gaps and Title Case still drift
- Evidence:
  - About 61 lines in `src` TS and TSX have a single-space sentence boundary in strings (heuristic).  Examples: `ApiKeys.tsx:85`, `ComputerPanel.tsx:302`.
  - JSX text with two ASCII spaces collapses in HTML, for example `RoutinesPage.tsx:353`.  The correct pattern is the `\u00A0` plus space form used in `ErrorRow.tsx:19`.
  - Sentence-case headings and titles remain: `NoEngines.tsx:49`, `LocalVmWorkspace.tsx:725`, `ChatView.tsx:1634`, plus "Your phone is ready" and others.  The most-clicked controls are affected too: "Cancel turn", "Always allow", "Pending approval" (`PendingApproval.tsx`).
- Impact: Violates binding owner rules.
- Recommendation: One `SENTENCE_GAP` helper and a lint that fails on literals.  (Effort: S)

### UX-18 [P3] [NEW] Small defects in recovery and tooltip copy
- Evidence: A literal `&amp;` shows in the icon-density tooltip and `aria-label` because it sits in a JS string (`Sidebar.tsx:3101-3102`).  The update-failure link points to `botfleet.io/download` (`ErrorRow.tsx:273`), the only `botfleet.io` reference in the repo, while the product domain is `botfleet.app`.  I could not confirm who owns `botfleet.io`.
- Impact: Visible entity text and a likely dead link.
- Recommendation: Use the plain character.  Point the link at the GitHub release.  (Effort: S)

### UX-19 [P3] [STILL-OPEN R11] The working timer is announced every second
- Evidence: The one-second interval sits inside `aria-live="polite"` (`TurnPresence.tsx:37-40`, `:79`).
- Recommendation: Move the counter outside the live region.  (Effort: S)

### UX-20 [P3] [STILL-OPEN R15 + R16] Unbounded transcripts and a second event stream in the Inspector
- Evidence: Messages append without trimming except for screenshot pixels (`store.tsx:1564-1593`).  The Inspector opens its own `EventSource` and copies the entries array per event (`InspectorPanel.tsx:63-82`).
- Recommendation: Trim unselected threads to one page.  Reuse the store's stream and cap entries.  (Effort: M)

### UX-21 [P3] [NEW] Idle mascots still wake four times a second
- Evidence: A paused mascot re-arms a 250 ms timer forever (`CursorAvatar.tsx:1583-1586`).  `animated` still defaults to true (`Avatar.tsx:166`).  Sites without the prop include `ResourceTriggersPanel.tsx:179`, `BotPickerList.tsx:33` and `FleetModelsSection.tsx:260`.
- Impact: Small but constant wake-ups per mounted face.
- Recommendation: Wake on prop change instead of polling.  Default `animated` to false.  (Effort: S)

### UX-22 [P3] [STILL-OPEN R19] Shiki loads its full bundle
- Evidence: `import("shiki")` at `ChatMarkdown.tsx:68` pulls the default bundle with every language.  The stale `dist/` listing in the integration tree shows hundreds of language chunks and a 622 KB wasm chunk.  Chunks load lazily, so this matters only on the first code fence.
- Recommendation: Use `shiki/core` with the JavaScript engine and a curated language list.  (Effort: S)

---

## Owner Commits (`02ed8ad15`, `7661f360a`, `99d018ecd`)

I diffed them against their own base, `9c49b1d3e`: 8 files, +44/-27.  Verdict: do not land them, because origin/main already carries both changes.

- **Draggable header:** main has it with typed styles (`ChatView.tsx:1211`, `GroupView.tsx:984`, `RoutinesPage.tsx:751`), landed in #839.
- **Per-user Local VM container:** main already has `sanitizeContainerSuffix(userInfo().username)` and `botfleet-computer` in the legacy prefix list (`server/container-computer.ts:67-73`).  The owner commit uses the raw username with no sanitizing.
- **Copy rename:** it turns "Cua" into "Computer Driver" and "BotFleet", which reverts the fleet's CUA standardization (#898, #860).  It also produces "BotFleet prepares BotFleet and the VM for you" in the `LocalVmRuntimeCard` hunk.
- The middle commit is a "restore corrupted files" repair, so the stack is noisy.  Discarding the local branch is the owner's call.

## Fixed Since Prior Audits

| ID | Status |
|---|---|
| UI2 | Settings, Plugins, Computer, Routines, Palette and others are `React.lazy` (`App.tsx:28-68`) |
| UI3 | Sentry and PostHog load by dynamic import (`sentry.ts:67`, `analytics.ts:31`) |
| UI5 | The roster sort is memoized (but see UX-5) |
| UI7 | `SidebarPhoneButton` is gated on page visibility (`:128`) |
| UI1 | The ChatView and empty-thread avatars are no longer animated while idle (`ChatView.tsx:908`, `:1584`) |
| R5 | Remote Access no longer hard-codes a personal tunnel (`remote-access.ts:1-10`) |
| R6 | A refused send restores the draft (`Composer.tsx:197`, `:360`) |
| Token streaming | Separate `StreamContext`; token frames no longer reach store consumers |
| ComputerPanel polling | All three preview intervals are gated on `pageVisible` (`ComputerPanel.tsx:475`, `:637`, `:678`) |

---

## Course Corrections

1. **Build one typed status contract and render it everywhere.**  Carry error code, reset time and quota state on the bot record, then drive the roster, chat header, matrix and iOS from one status component.  Stop re-deriving state from the last message's text (UX-1, UX-4, UX-16).
2. **Make "Needs You" a first-class surface.**  A permanent list of waiting approvals, errors and dead bots, keyboard Allow and Deny, a real command palette, and notification actions.  This serves the 10-bot power user's main loop better than more settings (UX-2, UX-9).
3. **Cut App Settings from 10 tabs to about 6.**  For example: General, Engines and Models, Connections and Secrets, Computers, Phone and Remote, Usage and Diagnostics.  Retire the "Legacy defaults" card, drop the vendor name from primary nav, and collapse the per-bot panel into progressive disclosure (UX-11).
4. **Replace the single monolithic context with selector subscriptions.**  Memoize roster rows, extract the streaming tail, and split the 3,300-line `Sidebar.tsx`, 2,000-line `ChatView.tsx` and 3,360-line `store.tsx` along those seams (UX-5, UX-6).
5. **Enforce copy and accessibility mechanically.**  One clock formatter, one sentence-gap helper, `ui-copy.test.ts` extended to string literals and `ios/`, both contrast scripts in CI, and Light as the first-visit default (UX-12, UX-13, UX-14, UX-17).

**Not determined:** which side wins the ⌘1 and ⌘2 collision (needs a live keypress test), actual render cost during streaming and tool-heavy runs (needs a profiler), and ownership of `botfleet.io`.

Relevant files: `src/components/ErrorRow.tsx`, `src/components/Sidebar.tsx`, `src/components/ChatView.tsx`, `src/components/Composer.tsx`, `src/components/PendingApproval.tsx`, `src/components/CommandPalette.tsx`, `src/components/Onboarding.tsx`, `src/components/SettingsNav.tsx`, `src/lib/settings-search.ts`, `src/lib/plain-preview.ts`, `src/state/store.tsx`, `server/contracts.ts`, `server/index.ts`, `electron/main.mjs`, `ios/App/ChatListView.swift`, `ios/App/Notifications.swift`.
