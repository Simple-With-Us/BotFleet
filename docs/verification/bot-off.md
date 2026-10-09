# Bot On/Off Switch

The On/Off fixture verifies that a bot switched Off starts nothing new from any source, keeps its chat readable, and finishes a turn that was already running.  It runs in an isolated test harness against a scripted local engine, never against the live app on port 8799 or the user's real bots.

## Setup

```sh
pnpm exec vitest run server/bot-off.test.ts server/bot-off-wiring.test.ts server/bot-power.test.ts
pnpm exec vitest run server/routines.test.ts src/components/BotOff.test.tsx
pnpm exec playwright test tests/e2e/bot-off.visual.spec.ts
cd ios && swift test
```

`server/bot-off.test.ts` boots a real harness with a throwaway HOME and a fake OpenAI-compatible engine.  Every "nothing started" claim is a counted fact: zero completion requests reached the engine.

## Steps

1. Switch a bot Off with `PATCH /api/bots/:id` (or the paired `PATCH /api/bots/:id/profile`) and `{ "off": true }`.
2. Post a message from each channel (the app, the iMessage relay, Linq) and an edit of an earlier message.
3. Deliver a webhook, run a routine with Run now, and fire a scheduled run.
4. Message an Off bot in a room, once by name and once through the room's default responder.
5. Start a turn held open by the fake engine, switch the bot Off mid-turn, queue a send behind it, then release the turn.
6. Restart the harness and read the roster.

## Expected Evidence

- Step 2: every post answers `409` with `code: "bot_off"` and the text "This bot is off.  Turn it on to chat.".  Nothing is steered, queued or written to the transcript.
- Step 3: each trigger leaves a `cancelled` run with outcome `bot_off` and the text "Skipped: this bot is off".  None is `missed` or `failed`, so the attention badge stays quiet.  Turning the bot back On does not replay them.
- Step 4: the Off member is skipped with a notice and the other members still speak.
- Step 5: the running turn finishes with its reply, and the queued send is dropped with a "Not sent" line instead of running.
- Step 6: `off` is still `true`.
- The disabled composer, the "Off" label and the dimmed avatar are pinned by `tests/e2e/bot-off.visual.spec.ts`.

## Key Behaviors Verified

- **Distinct from archive and stop:** `hidden` removes a bot from the roster, and a routine-manager stop is cleared by any person's message.  Off keeps the bot visible and survives a message; only an explicit Turn On clears it.
- **Gated where work starts:** `startTurn` (ahead of the stop decision), the messages route, the edit route, room turns, `ask_bot`, `delegate_bot`, job wakes and every automation manager.  `server/bot-off-wiring.test.ts` pins the order and counts the raw provider dispatches so a new path cannot skip the gate unnoticed.
- **Idle for updates:** queued work for an Off bot is settled, and what is left is excluded from update readiness.  A turn that is genuinely running still counts, because interrupting it would contradict "not interrupted".

## Not Proven

A real provider turn, a paired phone talking to a real computer, and the iOS screens on a physical device.  The phone is covered by `swift test` and simulator screenshots from the `-store-preview -preview-off` launch arguments.
