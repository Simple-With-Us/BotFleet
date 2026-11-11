# Zulip Wake Plugin (reference integration)

An optional user-installed plugin that routes qualifying Zulip DMs and
explicit bot mentions to the dispatcher inbox.  It exercises the full
event platform: install, configure, enable, inspect, test, disable,
update, remove.

## How it works

Zulip sends DMs and direct mentions to the host (outgoing webhooks for
configured bots, plus the native event queue — webhooks never deliver
every channel message).  The host authenticates, fetches the canonical
message, dedupes, and emits a `zulip.message` envelope.  This plugin's
`onEvent` applies the Zulip policy — mention/DM always qualify,
followed topics and peer senders per settings — and returns a
`requestWake` for the configured dispatcher bot with source context
(realm, channel, topic, thread, message id, bot identity) and the
scoped chat listing.  The host validates the target, enforces budgets,
and starts the dispatcher turn; the dispatcher decides where the
message belongs and replies through the Zulip connector, which posts
under the correct identity.

## Setup

1. In BotFleet, open Plugins → Install and point at this folder
   (`docs/plugins/zulip-plugin`).  It installs disabled.
2. Read the manifest: capabilities `events.subscribe`, `chat.read`,
   `dispatch.wake`; one `zulip.message` subscription.  No secrets, no
   network, no host writes.
3. Enable, then open Configure and health:
   - `dispatcherBotId` (required): the bot id whose inbox dispatches —
     usually the Director bot's BotFleet id (see Bots in the sidebar).
   - `allowPeerWakes` (default on): route non-owner messages too.
   - `routeFollowedTopics` (default on): route followed-topic messages.
4. Press Send test event and confirm a `delivered` outcome, then have
   someone DM or @-mention a bound bot and confirm the dispatcher turn.
5. Watch Health: pending, dead-letter, and recent outcomes with reason
   codes.  Nothing here shows message text or secrets.

## Files

- `botfleet-plugin.json`: manifest (capabilities, subscription, settings).
- `plugin.mjs`: `onEvent` policy, `getHealth`, `/zulip-health` command.
  Settings come from `host.settings`; credentials never appear here.

## Extending

Copy this folder for the next chat platform: keep transport in the
host (listener, auth, dedup), put routing policy in `onEvent`, and
request narrowly scoped host actions.  See
`docs/plugins/EVENT-PLATFORM.md`.
