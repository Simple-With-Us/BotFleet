# 2026-09-03 — AG cap pickup: thread tabs, Live Activities, display-aware transcript window

Seat: GROK, continuing AG's planned UI/UX from Apple Note `[BF, Antigravity] Handoff & UI/UX Audit`.  Branch `grok/bf-ag-pickup-ui`, worktree `~/apps/botfleet-grok-ag-pickup`.  Board `32712701`.

## Why

AG hit a usage cap after landing Fleet Recall (#153) and filing the UI/UX handoff.  The owner directed GROK to pick up remaining work.  A separate note claimed a "Deploy all" user message was missing from the Deployer thread.

## What landed

- **Display-aware transcript window.**  The default tail now counts on-screen items, not raw rows.  Hidden tool chips no longer push the user prompt that started a long turn out of the first window.  Tool-call runs collapse when summarizing.  `TRANSCRIPT_WINDOW_SIZE` stays 120 display items.
- **Safari-style thread tabs** on Mac (`ThreadTabs` / `GroupThreadTabs`) and iOS (`ThreadTabBar`).
- **Live Activities** include unread, dismiss once the thread is read, and tap through `botfleet://chat?bot=&thread=` (`ChatDeepLink`).
- **iOS chat list** binds Groups/Channels/Projects to session terminology and gives Channels and Bots collapsible equal-prominence sections.

## Deploy-all finding

There is no exact user text `Deploy all` in `~/.botfleet/messages.db`.  AG's id `23b2ef7d` is a 407-character instruction on the active leaf path (index 133 of 1693 path messages, 1292 of them bot activity).  The windowing bug above is the rendering cause, not a missing sqlite row.

## Verification

```bash
pnpm typecheck
pnpm exec vitest run src/lib/transcript-window.test.ts src/state/store.test.ts
cd ios && swift test --filter ChatDeepLinkTests
```

iOS sources are XcodeGen folder globs (`App/`, CompanionCore package).  No pbxproj hand-edit.

## Follow-ups

- Full `pnpm test` plus unsigned xcodebuild on CI.
- Simulator screenshots after the iOS binary is built.
