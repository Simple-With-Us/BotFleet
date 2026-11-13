Lens:  Chat-Product, read as the visual and interaction designer (GB-Designer seat):  hierarchy, density, honesty of status, copy, accessibility, iOS parity.

# Calm By Default, Honest When Loud

Cites are at main `268e80f`, read from code, nothing run.  R3 argues Chat-Product well; this paper tests the same surfaces against what a person sees, hears with VoiceOver, and reaches with a keyboard.

## Q1: Was The Overview An Improvement?

**Verdict:**  Better at one question for one person (the owner scanning many rooms for a stuck bot), worse for everyone else, and worst for anyone not using a mouse.

- The gain is real:  a single grid that ties rooms to bots, with a word in every cell ("Dead", "Needs Action", "Working", "Unread", "Assigned", `src/components/FleetMatrixView.tsx:381-389`), so status is not color-only there.  R7 is right that it answered a real request.
- The cost is a louder layer.  Motion is everywhere:  spinners and pulses in the deck (`src/components/AppDeck.tsx:150`, `:250`, `:355-357`) and the grid (`FleetMatrixView.tsx:358`, `:374`).  The reduced-motion rule covers only named classes (`src/styles.css:606-611`), not Tailwind's `animate-pulse` or `animate-spin`, so a person who asked the system for less motion still gets a pulsing grid (unverified).  The "working" dot is a round 1.5px dot told to spin (`FleetMatrixView.tsx:374`):  motion that conveys nothing.
- The deck's numbers are bare:  an icon and a digit, with the meaning only in a hover `title` (`AppDeck.tsx:219-240`).  The chip's `aria-label` is just "{name} {App}" (`AppDeck.tsx:190`), which replaces the inner text, so VoiceOver hears "CodeCaps App" and none of its counts.
- The Kanban card, the one surface that ranks what needs you, is a `div` with `onClick` and no role, `tabIndex` or key handler (`src/components/KanbanCommandCenter.tsx:597-600`).  A keyboard user cannot open an attention card at all.

I agree with R3's verdict; the accessibility gap makes it worse than R3 says.

## Q2: Is The Top Of The Main Pane The Right Home?

**Verdict:**  No.  The header card and pills belong inside an Overview destination; the deck strip should leave conversations entirely.

- The deck mounts above every view once one non-DM room exists (`src/App.tsx:105`, `:424`), and the overview is reachable only through its All tab (`AppDeck.tsx:107-120`); the palette has no overview entry (`src/components/CommandPalette.tsx`, no match for "overview").
- A chat screen's hierarchy is transcript, then composer.  Pulsing colored chips above the transcript win the eye whenever anything anywhere changes, against the room view's own rule of still avatars (per R3, `src/components/GroupView.tsx:3-5`).
- I disagree with R7 and R10, who keep a compact deck above conversations as a switcher.  A second room switcher in a different order (`AppDeck.tsx:57-60` against the sidebar's recency, per R3) teaches two maps.  If a scope is wanted above a chat, make it one plain breadcrumb with no counts and no motion (close to R8-codex's "compact context switcher").
- Agree with R1, R3, R8 and R8-codex:  an Overview row at the top of the sidebar, a palette entry and a shortcut.

## Q3: Which Views Earn Their Place?

**Verdict:**  Needs You is the default Overview view.  The Matrix stays as a secondary coverage view.  The Kanban Board should be cut back until its cards mean different things visually.

- Needs You:  copy the phone, which already has the right model (`ios/App/Updates.swift:1-6`: needs an answer, mid-turn, finished-unread; "A bot that is idle and read is not an update").  A list is also the most accessible shape there is:  one row per item, a real button, a reason in words, and real verbs.  Agree with R2, R3, R7, R10 and R8-codex.
- Matrix:  keep, with bot status moved to the column header and cells labelled "Member" instead of "Assigned" (`FleetMatrixView.tsx:389`), as R1, R6 and R10 propose.
- Kanban:  I disagree with R8-echo making it the default.  Every attention card has the same amber border (`KanbanCommandCenter.tsx:600`) even though each card carries a `statusKind` of danger, warning, info, success or neutral (`:228-437`) that nothing reads.  A dead bot looks like a waiting question.  Its call to action reads "Unblock" (`:657`) on what is plain navigation.
- Missing:  a calm empty state ("Nothing needs you") that is the most common screen and the one that earns trust, and a one-line legend that maps each status to one color, one icon and one word.

## Q4: How Should Threads, Bots And Apps Be Organized?

**Verdict:**  The conversation is the destination and the bot is always named on it.  Rooms are a scope, not a second list.  Yes, the deck duplicates the sidebar's room list.

- Agree with R1 and R8-codex that the App should be a scope that narrows the sidebar and the overview, and with R5 that the deck's member sub-bar (`AppDeck.tsx:283-368`) is the one part with no sidebar twin.  That jump belongs on the room's own header, not in a global strip.
- Naming:  one word everywhere.  The Mac titles the arrangement option with the room plural (`src/components/SettingsModal.tsx:672`); "Room Chat" ignores terminology (`FleetMatrixView.tsx:210`); the subtitle says "software development workspaces" (`:114`).
- R1 and R8-echo want typed badges on sidebar room rows.  Agree, with a condition:  today's sidebar dots have the same flaw as the deck, meaning only in a `title` (`src/components/Sidebar.tsx:1879-1891`).  Moving badges there must bring an accessible name that includes the state in words, or it just moves the problem.

## Q5: Should Workspace Arrangement Grow?

**Verdict:**  No new runtime arrangement tonight.  One new control, Start On, in its own Mac-only card.

- **Simple:**  keep, and make its card true (the room "+" is not gated, per 01 T2).
- **Bots + Rooms:**  reject.  The data already hides rooms when there are none (`src/App.tsx:105`).
- **Fleet:**  accept as the stable name for today's second option, so the option title never borrows the room word (`SettingsModal.tsx:672`).  Do not promise per-thread models until the picker sends them (01 T8).
- **Bot Homes:**  defer.  One busy flag shows "Working" in every home (02 § 1), and status that lies is worse than none.
- **Threads:**  reject as a mode.  Hiding the bot hides why a thread is waiting; prototype it as an Overview filter instead.
- **Command Center:**  reject as an arrangement, accept as a Start On value.
- **Start On (from 02 § 2):**  Last Conversation (default), Needs You, Overview, as R3 proposes.  It must sit in its own card labelled "This Computer Only", because the arrangement card promises it applies on the phone too (per R3).  No proposal of my own beyond this.

The overview does not make Simple versus Fleet moot.  It makes the difference visible:  in Simple every cell of a bot opens the same conversation (`src/lib/task-app-thread.ts`, per 01 § 3), so the grid implies structure that is not there.

## Q6: What Must Change Whatever The Outcome

**Verdict:**  Fix what is inaccessible, what lies, and what fails silently.

Already handled, do not relitigate (agree with R6, R10, R8-codex):  overview self-dismissal `6689e3f3` (now `useDismissOnSelection`, `src/App.tsx:128-129`), the card flood `fbd2be5e`, the pill double count `710979ea`, and the false arrangement copy `20725f10`.

Still wrong:

1. **Keyboard and VoiceOver cannot reach attention cards** (`KanbanCommandCenter.tsx:597-600`).  Make each a real button.
2. **Counts are mouse-only** (`AppDeck.tsx:190`, `:219-240`; `Sidebar.tsx:1879-1891`).  Accessible names must say "CodeCaps, 1 error, 2 working".
3. **Motion ignores the reduced-motion setting** (`AppDeck.tsx:150`, `:355-357`; `FleetMatrixView.tsx:358`, `:374`; `src/styles.css:606-611`).  Use `motion-safe:` or a global rule.
4. **Every attention card is amber** (`KanbanCommandCenter.tsx:600`); read `statusKind`.
5. **Verbs that overpromise:**  "Unblock" (`:657`) is navigation.  Say "Open", or "Answer" only when the card's options are offered in place.  Agree with R10.
6. **The arrangement save swallows its error** (`SettingsModal.tsx:661-662`, an empty `catch`).  A refused merge must show a persistent card with the server's real reason that stays until hidden, never a toast that disappears.  Agree with R6, who ranks this worst.
7. **Copy:**  "Active Bots" counts visible bots (`FleetMatrixView.tsx:158`; R10's "Visible Bots" is right), "Assigned" means member (`:389`), "Mission control view across all software development workspaces" (`:114`) is jargon.  Under row `20725f10`.
8. **Density:**  27 uses of 9px and 10px text across the three components (`rg "text-\[(9|10)px\]"`).  Make 11px the floor (effect of app zoom unverified).

## Ranked Recommendations

1. **Honesty and access pass on the overview (S).**  Real buttons for cards, accessible names with counts in words, `statusKind` driving color and icon, reduced motion honored, truthful verbs, and the swallowed 409 shown as a persistent card.
2. **Overview destination with Needs You first, deck off conversations (M).**  Sidebar row, palette entry and shortcut; Needs You modeled on the phone's Updates rules; Matrix secondary; Start On in its own Mac-only card.
3. **One status vocabulary across Mac and phone (M).**  Five states (Needs You, Failing, Working, Unread, Idle), each with one color, one icon and one word, used by sidebar dots, the overview, the dock and iOS, with a legend.  Count distinct bots, never rooms times bots.

## The Owner's Decision

Do you still want a fleet strip above every conversation?  The deck is your Option C request, so only you can retire it.  My advice:  take it off chats and keep its status inside the Overview destination, so a conversation is calm unless something actually needs you.
