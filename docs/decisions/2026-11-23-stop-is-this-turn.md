# Stop is this turn; Off is the only hold

**Date:** 2026-11-23
**Status:** Owner ruling, confirmed in the owner's own words ("stop is only current turn", settled earlier and reaffirmed this date).

## Decision

Stop cancels only the current turn. It interrupts the turn running now,
closes its approvals, and cancels the routine run that turn was carrying.
It leaves nothing behind: no latch, no snooze, no persisted state. The next
webhook, schedule, resource trigger, Zulip message, job wake, or person's
message starts a turn exactly as it would have before the Stop.

Off is the only persistent hold. It refuses every new turn, a person's
included, until an explicit Turn On.

## Replaces

- Sep 21 (#514): Stop snoozed every automation for the bot until the
  person's next message.
- Oct 2 (#802): the snooze was made to outlive updates and resumes ("a
  stopped bot stays stopped").

The snooze lived in `routines.json` as `botSnoozes`. No client displayed
that state, and a stray Stop on an idle bot could set it. On upgrade, any
`botSnoozes` an older build saved are ignored and never written again, so
updating unlatches every install by itself.

## Consequences

- `server/bot-stop-policy.ts` no longer decides whether a turn may start;
  there is no stop state to consult. It only identifies an intentional Off
  refusal (`botOffError` / `isBotOffError`) for callers that retry.
- `interruptBot` no longer snoozes the bot.
- Dispatch paths that used to refuse with `bot_stopped` no longer have that
  outcome; callers classify only `bot_off` as a deliberate refusal.
