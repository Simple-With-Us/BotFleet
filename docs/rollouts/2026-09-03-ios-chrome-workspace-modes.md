# 2026-09-03 — iOS chrome, Simple/Projects layout, crop, quota

Seat: GROK.  Branch `grok/ios-chrome-workspace-modes`.  Worktree `~/apps/botfleet-grok-ios-chrome`.  Board `4498c349`.  Issue #180.

## Workspace layout

Two modes, default Simple.  They are not the same feature with two labels.  Room terminology still names them (Channel, Group, Project, or a custom pair).

- **Simple** — Grok-style.  Named bots, one conversation each.  Rooms are group threads: one shared conversation per room that invited bots and the user write in.  Extra bot tasks stay saved but stay hidden.  Automation writes into that one conversation.
- **Projects** — Claude / Codex / Antigravity style.  Named bots stay hidden.  The room word is a category, and any number of threads sit under it.  Each thread can carry its own model and fallbacks.  Webhooks, resource samples, and schedules each reuse one thread of that type.

A leftover `fleet` value from an earlier draft is read as Projects.

## iOS chrome

Conversation tabs are an opaque header.  The transcript starts below them and does not show through.  The home green initial is gone.  Home compose is a menu (New Bot / New Thread and New Channel), not an immediate createBot.  The same compose control sits next to the computer button on a bot page in Projects.

## Room photos

iOS honors circle / rounded / square from the Mac.  Default shape matches Mac (rounded).  The photo-shape picker is on the room profile.

## Usage

Cost per bot is the sum of each settled turn as that turn's engine reported it, including fallbacks.  Cursor and Antigravity no longer stay Available after a real per-model cap: the picker looks up any cooldown for that instance, not only `*:instance:*`.  The boot-time fake Codex cap is gone.

## Verify

```
pnpm exec vitest run server/conversation-mode.test.ts server/routines.test.ts server/model-fallback.test.ts companion/test/routes.test.ts
cd ios && swift test --filter DecodingTests
```
