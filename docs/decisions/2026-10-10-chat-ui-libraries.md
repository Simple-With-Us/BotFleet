# Chat UI Libraries: assistant-ui (macOS) + Exyte Chat (iOS)

**Date:** Sat, Oct 10, 2026
**Seat:** MM
**Board:** `2b6d247c`

Owner decision (Sat, Oct 10, 2026): use [assistant-ui](https://www.assistant-ui.com) for the macOS
chat surface and Exyte Chat for the iOS chat surface.

This doc records what was **verified in an isolated fixture**, what is blocked, and the
recommended scope.  It does not migrate anything yet.

## Correction to the prior audit

Board item `1cdc995e` (BF-DIRECTOR, 2026-09-30) states Exyte Chat "is the iOS chat surface
today".  **That is wrong, and it matters.**  Exyte Chat is not in the repo at all:

- `git grep -i exyte` across all tracked files matches **exactly one line** — the audit's own
  row in `docs/EFFORT-LOG.md:1020`.
- `ios/project.yml` has **no** `exyte/Chat` SPM package; there is no `ios/Package.resolved`
  and no Kingfisher pin.
- No commit on any branch mentions Exyte.

The same audit also describes the macOS app as "hand-rolled SwiftUI in `mac/Sources/`".  There is
no `mac/` directory.  The macOS chat is Electron + React: `src/components/ChatView.tsx`
(1,972 lines), plus `ChatMarkdown.tsx`, `ChatFindBar.tsx`, `Composer.tsx`.  Both surfaces are
hand-rolled today; nothing is borrowed yet.  Treat the prior audit's adoption status as wrong
rather than as a starting point.

## macOS — assistant-ui: **GO**, with one upstream caveat

Verified by building the adapter for real in this lane, not by reading docs.

### The seam works

BotFleet does not use the Vercel AI SDK.  Messages arrive from the harness over the Electron
bridge (`useStreaming()` in `src/state/store.tsx`, per-thread deltas flushed on
`requestAnimationFrame`).  assistant-ui's `useExternalStoreRuntime` accepts any custom store, so
the harness stream maps onto it directly:

| Concern | assistant-ui API | BotFleet equivalent |
|---|---|---|
| Message list | `messages` + `convertMessage` | `visibleMessages` from the store |
| Streaming | mutate the assistant message in place | rAF delta buffer already does this |
| Send | `onNew(AppendMessage)` | `POST /api/bots/{id}/messages` |
| Regenerate | `onReload(parentId, config)` | harness regenerate endpoint |
| No AI SDK | deps are `core`/`store`/`tap`/`zustand`/`zod`/`radix-ui` | no `ai` package at all |

Minimum adapter surface is small: `messages` (optional) plus the one required `onNew`.
Non-`ThreadMessage` types additionally require `convertMessage`.

Verified in this lane (`src/components/assistant-ui/`):

- `pnpm exec tsc --noEmit` — adapter typechecks clean against the real 0.15.27 types.
- `BotFleetExternalStore.test.tsx` — 9/9 pass, including an SSR render of the harness
  messages through `ThreadPrimitive.Messages` / `MessagePrimitive.Parts` with no AI SDK
  present.
- **A/B check on every behavioral test:** breaking the streaming tail fails the stream test;
  dropping the text in `convertMessage` fails 3 tests including the render test; reverting the
  synthetic-message path fails that test; stubbing the reload forwarding fails that test.  Each
  test can fail, so each is a real check.
- Existing `ChatView.test.tsx` + `ChatMarkdown.test.tsx` still pass (23/23) — nothing regressed.
- Full `src` suite: 191 files / 2,423 tests pass.  Lint ratchet passes at 4,872 warnings against
  a 4,890 baseline.  Zero type assertions in the adapter.

Works outside Next.js: zero `next/*` imports in `dist`, `"use client"` is inert, React peer is
`^18 || ^19` and BotFleet is on `^19.1.0`.  MIT throughout.

### What the review round changed

Three things the first pass got wrong, all caught by review and fixed:

1. **Streaming before the settled message was dropped.**  The harness streams tokens *before* the
   settled message lands — `ChatView.tsx:1774` renders exactly that window as a live bubble.
   `appendStreamTail` used to early-return when the tail message was not an assistant message, so
   those tokens vanished.  It now appends a synthetic assistant message
   (`STREAMING_MESSAGE_ID`), keeping the running state and the visible text in sync.
2. **A reasoning-only stream did not count as running.**  BotFleet streams `reasoning` and `text`
   as separate frames; only `text` was consulted.
3. **The render test asserted a literal.**  It passed regardless of whether the store reached the
   DOM, because it asserted on a hardcoded child string.  It now routes the harness messages
   through the primitives and asserts that *our* text appears — and it fails when the data does
   not arrive.

A note on the primitive API, since it is easy to get wrong: `ThreadPrimitive.Messages` takes a
**render-function** child (it maps over the thread's message ids), and `MessagePrimitive.Root`
renders its children verbatim — `MessagePrimitive.Parts` with a `components.Text` override is
what actually renders message text.

### Where review and this doc disagreed

Review proposed guarding `isRunning` with `last.role === "assistant"`, so it could not report
"running" while no streamed tail was rendered.  That was right *before* fix (1) and wrong after
it: once `appendStreamTail` appends a synthetic assistant message, a rendered tail exists in
every streaming frame, and the guard would hide the working state during exactly the window where
the user needs it — tokens streaming before the settled reply lands.

The contract is now "isRunning ⇔ a streamed tail is rendered", maintained by the single rule in
`appendStreamTail` rather than by two conditions kept in sync by hand.  A test
("stays running when tokens stream before any settled bot message") pins it so the disagreement
cannot resurface silently.

This is the general hazard with this library: a "keep these two in sync" suggestion can be
correct in isolation and wrong once another fix changes the invariant it was reasoning about.
Re-derive against the current code rather than applying it to the version it was written for.

Not every suggestion was wrong, though, and the distinction is worth drawing.  A later pass
correctly noted that `onReload(parentId, config)` receives a `StartRunConfig` carrying
`sourceId` and `runConfig`, which the adapter was dropping — regenerate should forward the
harness' own branch semantics rather than discard them.  That one was kept and given tests.

So the test applied was: *does this suggestion describe reality that is still true in the current
code?*  The sync guard described a real inconsistency, but its premise had been removed by an
earlier fix.  The reload forwarding described a real gap with no competing fix.  The final pass
(a synthetic bubble that reused the triggering message's timestamp) described a real ordering
bug: an equal `createdAt` leaves the bubble's position up to the renderer's tie-break.

A caution about writing the test for that last one: the obvious assertion is `>=`, and that is
vacuously satisfied by the tie that *is* the bug.  The A/B check caught it — the test passed
against sabotaged code.  The property is strictly greater.

One typing consequence: neither `RunConfig` nor `StartRunConfig` is re-exported by
`@assistant-ui/react` (only `CreateStartRunConfig` is), so those shapes are written structurally
and documented where they are declared.

### Blocker found: `@assistant-ui/react-ui` is broken upstream

Do **not** plan around the pre-styled package.  Every published `@assistant-ui/react-ui`
(0.1.8, 0.2.0, 0.2.1) imports `useAssistantRuntime` from `@assistant-ui/react`, and **no
published `@assistant-ui/react` (through 0.15.27, the `latest` tag) exports it.**  It fails at
import time:

```
SyntaxError: The requested module '@assistant-ui/react' does not provide an export named
'useAssistantRuntime'
```

`useAssistantRuntime` exists in none of 0.15.10 / 0.15.20 / 0.15.27, and there is no beta or
canary tag to fall back to.  The spike therefore builds on `ThreadPrimitive` and friends from
`@assistant-ui/react` directly, which work.

Consequence: **we style the chat ourselves.**  BotFleet already owns its chat look — themes
(Studio / Midnight / System Auto), `ChatMarkdown` with shiki, mascot, tool cards, find bar,
request-ID copy — so owning the components loses nothing we had.  It also means the "drop-in
styled UI" benefit is not available today.

If upstream fixes it, `@assistant-ui/react-ui` becomes an option; it is not on the critical path.

### Scope note

`@assistant-ui/react-markdown` depends on `react-markdown@^10.1.0`, the major BotFleet already
uses, and exposes `SyntaxHighlighterProps` for shiki.  No conflict, but it is optional — we can
keep `ChatMarkdown` as-is.

## iOS — Exyte Chat: **MIXED; recommend against a full swap**

Verified by reading the actual source (cloned `exyte/Chat` @ `49bf1f3`, 2026-10-01).

Facts:

- MIT, actively maintained (HEAD 2026-10-01), 113 Swift files / 12,515 lines.
- iOS 17+ (BotFleet targets 27.0), Xcode 15+, Swift tools 6.1.
- Customization is genuinely good: `messageBuilder`, `inputViewBuilder`,
  `mainHeaderBuilder`, `dateHeaderBuilder`, `betweenListAndInputViewBuilder`, plus separate
  `chat/message/input` customization parameter structs.  Styling is *not* imposed.
- Bring your own backend — which BotFleet already has, so no Firestore detour.

Reasons not to swap wholesale:

1. **`Message` is a concrete struct, not a protocol.**  `ChatView.init` requires
   `messages: [Message]` — we would have to map BotFleet's model into Exyte's fixed struct
   (`id`, `user`, `status`, `createdAt`, `attributedText`, `attachments`, `reactions`,
   `customData`, …).  That is a standing translation layer, not a drop-in.
2. **The message list is a wrapped `UITableView`.**  `UIList` is a `UIViewRepresentable`.  It is
   not SwiftUI `List`/`ScrollView`, so it cannot host BotFleet's `Glass.swift` Liquid Glass
   surfaces the way native SwiftUI can, and our 615 lines of custom cards (SQL result table, PR
   diff, thought chamber, skill receipt) would have to live inside UIKit cells.
3. **Dependency risk against our CI.**  It pulls Kingfisher `from: 8.5.0`, `giphy-ios-sdk`
   (exact `2.2.16`), `exyte/MediaPicker`, `exyte/AnchoredPopup`.  Kingfisher ≥ 8.13 requires
   Swift 6.2 and breaks CI on Xcode 16.4 (lesson 2026-09-28), so a resolver bump silently
   re-breaks the build.  That needs a pin and a guard.
4. **The message menu is a closed generic** (`MessageMenuAction` with `static menuItems(for:)`),
   so our long-press actions need a conformed enum — fine, but more surface.

The GitHub repo shows an `exyte/Chat` commit-activity warning, and Stream's comparison notes it
is a showcase library from an agency.  That is not disqualifying; it just means we own the fork.

### What it would actually buy

A better default bubble / long-press / attachment-input treatment, and pagination.  Given we
already have `ChatView.swift` (2,644 lines) and `ChatListView.swift` (1,348), that is an
incremental win against a large rewrite.

### Recommendation

**Borrow the input view and message-cell patterns; keep our own chat container.**  Take
Exyte's `inputViewBuilder` shape (composer, mention autocomplete, predictive action chips,
command-skill HUD already exist under `ios/App/Composer/`) and its bubble styling as reference
for `ChatView.swift`, but keep the native SwiftUI scroll container so Glass and the custom cards
keep working.  A full `ChatView`-replacing swap trades a working Liquid Glass surface for a
UIKit-backed one — that is a downgrade, not an upgrade.

If the owner wants the full swap anyway, the blockers above are the checklist: model mapping,
Kingfisher pin + CI guard, Glass re-skin, and a card-rendering plan for the four custom cards.

## Landed in this lane

- `src/components/assistant-ui/BotFleetExternalStore.ts` — the adapter, harness-shaped, typechecks.
- `src/components/assistant-ui/BotFleetExternalStore.test.tsx` — 4 tests, A/B-verified.
- `@assistant-ui/react` added as a workspace dev dependency (pinned; `react-ui` deliberately not
  adopted while it is broken).

No user-visible surface changed.  This lane is the proof, not the migration.

## Suggested next steps

1. **macOS** — port `ChatView` incrementally onto `ThreadPrimitive`, one region at a time behind
   the existing surface, keeping `ChatMarkdown`, themes, mascot and tool cards.  Start with the
   message list and viewport; leave composer, find bar and thread tabs as-is.
2. **iOS** — extract Exyte's composer and bubble patterns by reading them; no dependency yet.  Revisit the full swap only if the owner wants it.
3. Re-check `@assistant-ui/react-ui` on a later version before ever adopting it.

## Sources

- <https://www.assistant-ui.com/docs.md>, `/docs/runtimes/custom/external-store.md`,
  `/docs/installation.md`
- `@assistant-ui/react@0.15.27`, `@assistant-ui/core@0.3.26`, `@assistant-ui/react-ui@0.2.1`,
  `@assistant-ui/react-markdown@0.14.20` tarballs (types read directly)
- `exyte/Chat` @ `49bf1f3` (source read directly)