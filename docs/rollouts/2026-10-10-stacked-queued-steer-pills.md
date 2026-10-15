# 2026-10-10 — Stacked queued steer pills, slash cleanup, iOS composer polish

## Context & Objective

Linear **BF-2395** (board `b5146817`, original lane `ag/steer-queue-and-ios-scroll`).  Replace the dummy Steer control and transcript steer links with Clutch/Antigravity-style stacked queued message pills above the composer on desktop and iOS.  Each pill exposes edit, cancel, and steer-now.  Remove text-inserting slash commands (`/steer`, `/diff`, `/retry`) while keeping functional commands (`/computer`, `/tasks`).  On iOS: inline keyboard dismiss when typing, long-press send menu (Steer Now vs Queue Message), and thread open/switch auto-scroll that settles on the newest message after layout.

Implementation landed in GitHub **#1052** (supersedes closed **#1045**).  This rollout doc closes the Linear bookkeeping loop for BF-2395.

## Changes Made (shipped in #1052)

**Desktop (`src/components/Composer.tsx`, `src/components/ChatView.tsx`)**

- Stacked `pendingQueued` pills with `queuedChipLabel`, edit / cancel / steer-now actions.
- `Cmd/Ctrl+Enter` steers immediately when the queue is non-empty; placeholder reflects the shortcut.
- Queued edit restores through `restoreFailedSend` so attachments and reply targets are not dropped.

**iOS (`ios/App/ChatView.swift`, `ios/App/Composer/CommandSkillHUDView.swift`, `ios/App/Session.swift`)**

- Matching queued pill row; keyboard dismiss control when `composerFocused`; send `contextMenu` for Steer Now vs Queue.
- `cancelQueuedMessage` waits for the server on bot threads (room queue stays client-only).
- Thread-keyed `.task(id: threadId)` scroll with a short settling pass after dynamic layout.

**Tests**

- `tests/e2e/queued-steer-pills.visual.spec.ts` — three Linux screenshot cases (board `b5146817`).
- `tests/e2e/composer-draft.spec.ts` — queued edit restore with attachments; bot cancel waits for harness.

## Decisions & Trade-offs

- Bot `pendingQueued` is filled from the POST response only (no GET); Playwright specs drive the queue like a person sending into a busy bot.
- Visual baselines are `chromium-linux` renders (CI `ubuntu-latest`), not macOS fonts.

## Verification State

```bash
pnpm typecheck
pnpm exec vite build
pnpm exec playwright test tests/e2e/queued-steer-pills.visual.spec.ts tests/e2e/composer-draft.spec.ts
pnpm exec vitest run src/lib/update-control.test.ts
```

Cloud agent re-run (2026-10-15): typecheck clean; 18/18 Playwright cases above passed after `playwright install chromium`; `update-control` vitest 37/37.  Full `pnpm test` and unsigned `xcodebuild` remain the hosted merge gate for non-docs paths; this closeout PR is documentation-only.

## Tracking

- Linear: BF-2395 → mark **Deployed** when this doc merges.
- GitHub: #1052 (merged 2026-10-11).
