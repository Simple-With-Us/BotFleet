# Per-Room Attention Index

Why the workspace app bar cannot be built on today's state model, and what has to exist first.

## Summary

A bot has exactly one activity, globally.  The attention bar we want — errors, needs-action, working and unread, per app — cannot be produced from that.  This document specifies the state that has to exist first: a derived, mostly-transient attention index keyed by (bot, room), plus one durable class of entry so a real failure survives a restart.

This is a spec, not an implementation.  It exists so the attention layer is not built twice.

## The Gap

`setActivity` is the only writer of a bot's activity, and it takes a bot id and nothing else:

```ts
// server/store.ts:1945
setActivity(botId: string, activity: BotActivity): BotRecord | null
```

`BotRecord.activity` is a single scalar — "What the bot is doing right now, as the harness sees it" (`server/store.ts:670`) — and it is deliberately transient, reset to idle on load (`server/store.ts:1942`).  `BotActivity` is `"working" | "waiting-on-you" | "idle" | "no-signal" | "dead"` (`server/store.ts:538`).

There is no per-room and no per-task activity anywhere.  `TaskRecord` (`server/store.ts:285`) has no activity field at all.  The only room-scoped runtime state is `GroupRecord.busyBotId` (`server/store.ts:256`), which answers exactly one question — which bot currently owns the provider process in this room — and cannot express waiting-on-you or an error.

Three consequences, each visible in the UI we are designing:

1. A bot mid-turn in BotFleet occupies the single activity slot with `working`.  Whether it is *also* holding an approval for you in FleetLink is unrepresentable.
2. A bot idle in Congress.Trade while an unanswered question sits in BotFleet produces no Congress.Trade signal, because no per-room attribution exists to miss.
3. A bot that died in one room looks identically idle-or-dead in every other room.

This is the same class of problem as the singular `BotRecord.inflightThreadId` (`server/store.ts:676`): the "one thing at a time" constraint is expressed in the *shape of the data*, not only in the dispatch check.  `server/index.ts:6883` enforces `if (bot.busy)`, but the shape already assumed it.

## The Shape

An attention index keyed by (botId, groupId), derived at settle time from the same events that already call `setActivity`.  Three properties, in priority order:

**Transient by default.**  Working and needs-action reset on load, exactly as `activity` does today.  A persisted attention index would resurrect stale badges after a restart, which is worse than showing nothing: a badge that says "waiting on you" when nothing is waiting teaches the user to ignore badges, and then the badge that mattered is ignored too.

**Durable for errors only.**  An unresolved failure must survive a restart, or the app understates a real problem after the one event that could fix it.  `dead` and any errored turn are persisted; `working` and `waiting-on-you` are not.  This is the single exception and it should be argued about explicitly rather than inherited from the transient default.

**Derived, not stored twice.**  Where a value is already known — `busyBotId`, `unread` on both `BotRecord` and `GroupRecord` (`server/store.ts:581`, `server/store.ts:250`) — the index references it rather than mirroring it.  Two copies of the same fact drift.

## The Typed Badge Contract

Four types.  They are never summed into one number.

| Badge | Source | Meaning |
|---|---|---|
| Errors | durable entries, plus `dead` | Something failed and is unresolved. |
| Needs Action | `waiting-on-you` in this room | A permission request or question is open. |
| Working | `working` in this room | A turn is in flight. |
| Unread | `unread` on the room | A reply is unread. |

Each badge is clickable to the bot, the task, the reason, and the next action.  Reading an error does not resolve it; opening a room does not approve anything.  Tool logs and bot-to-bot chatter must not inflate the unread count — that is the transcript rule in `channel-triggers-and-concurrency.md`, applied to the counter rather than the channel.

The dock's existing single number stays.  `unreadConversationCount` (`src/lib/unread.ts:1`) feeds the app-level badge at `src/App.tsx:75`, and at that altitude one number is correct.  The dock number and the per-room typed row are different questions and should not be unified.

## Ranking

Rank by what a decision unblocks, then by how long it has waited.  Never by recency and never by message count.  A thread with four unread replies costs nothing; a permission request open for forty minutes is silently stalling a repository.

## What This Does Not Solve

Concurrency.  Two live threads per bot is blocked by `bot.busy` (`server/index.ts:6883`) and by the single `inflightThreadId` crash marker, and neither is an attention problem.  The attention index makes the *display* honest; it does not make parallel execution possible, and it must not be allowed to imply that it does.

## Open Decision

Where the index lives: in `server/store.ts` beside the records it describes, or in a separate module that observes store changes.  The first is simpler and keeps the derivation next to `setActivity`; the second keeps a 2600-line store from growing a second responsibility.  This is a call worth making once, deliberately, and it is not made in this document.
