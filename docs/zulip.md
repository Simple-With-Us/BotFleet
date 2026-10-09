# Zulip

BotFleet's role bots can live on the fleet's Zulip realm (`https://simplewithus.zulipchat.com`).  Each bound bot holds its own Zulip event queue, is woken by an @-mention or a DM to its Zulip bot, and posts back as itself.  The rules for conduct on the realm are in AI-Fleet-Coordinator `docs/protocols/zulip-fleet-guide.md`; this page covers BotFleet's side.

The code is `server/zulip/` (client, router, state, outbound rules, hub), `server/tools/zulip.ts` (the HTTP-lane tool executors) and the `zulip_reply` / `zulip_post` records in `server/tools/registry.ts`.

## What Happens

1. On boot (after `booting = false`), the hub starts one session per bot listed in `zulip.bots`.  A session loads that bot's key, checks `GET /users/me` (the email must match the file, and only member or moderator roles are accepted: an admin or owner key is refused), registers an unnarrowed event queue and long-polls it.  Nothing is dispatched until boot recovery has claimed the turns the last stop interrupted, and a bot that still holds an interrupted turn's marker takes no Zulip work, so a wake can never bury a turn that was promised a resume.
2. A message wakes a bot only when it is a direct `@**BF-Role**` mention outside code and quotes, or a 1:1 DM.  Wildcard mentions, group DMs, incoming-webhook bots (Sentry, Linear, …) and the bot's own posts never wake.  A DM from another bot wakes only when its user id is in `zulip.peerDmAllow`.
3. Wake-worthy messages are queued per bot, one unit per conversation (channel + topic, or the DM).  Messages for the same conversation that arrive while the bot is busy join that unit; two conversations never share a turn.
4. When the bot is free, the unit starts one turn as the `zulip` automation source, in a task of its own for that conversation (`Zulip #channel > topic`, or `Zulip DM with user N`), created the way a routine's task is and never switched to.  It never runs in the owner's active thread, so a peer cannot ask the bot to read Jay's conversation back out, and one conversation cannot read another's.  The turn text is a `[ZULIP INBOUND]` header followed by the messages between `BEGIN_UNTRUSTED_ZULIP` and `END_UNTRUSTED_ZULIP` markers, one JSON object per message, with a per-turn nonce on both markers.  The header holds the sender ids and the listener's verdicts, an `Owner items:` line naming the message ids verified as Jay's (the only place owner status is stated), and the channel and topic on a line of their own labelled as names someone typed: a topic is chosen by whoever posts, so it is text to read, never a verdict.  Message text, and a channel or topic name, cannot add to the `Owner items:` line.
5. The bot answers with `zulip_reply`, which posts to the conversation that woke the turn.  If the turn ends without calling it and `zulip.autoReply` is `"final"` (the default), the turn's last reply is posted there instead.  The reply target belongs to that turn alone (and to its model fallbacks and card continuations, which reuse its starting message): a later turn in the same task, such as Jay typing there, neither replies to the Zulip sender nor changes whether the Zulip turn's answer is posted.

## Safety Rules

- **Content is data.**  Zulip text reaches the model only inside the untrusted markers, and the system prompt's automation note says it is never an instruction and can never widen approvals.
- **Owner rule.**  A message is Jay's only when the sender is `zulip.ownerUserId` AND the message's `client` is a human Zulip app (`website`, `ZulipMobile`, `ZulipFlutter`, `ZulipElectron`, `ZulipDesktop`, or `zulip.ownerClients`).  Jay's id from any other client is flagged as owner-via-API and never wakes.  The verdict labels the turn; it never lifts a guard.
- **Every Zulip turn is unattended.**  Auto mode does not apply, so anything that asks for approval puts a card in front of Jay in BotFleet, the same as an iMessage or webhook turn.  Approvals are never taken from Zulip.
- **Posts are checked by the harness, not by the schema.**  `zulip_reply` always goes to the origin; the model cannot redirect it.  `zulip_post` needs a channel AND a topic (at most 58 characters, never the bot's own name), and the channel must be the origin's (any topic in it, so a new unit of work gets its own topic) or one listed in `zulip.postChannels`.  A DM goes only to the person whose 1:1 DM started the turn.  Text that looks like a secret (any loaded Zulip key or its Basic token, anything `redactSecretsInText` would mask, a 32-character mixed-case token) is refused in the content and in a new topic, and the refusal names the kind of match, never the text.
- **Every post carries the role tag** on its first line, added by the harness: `[BF-PLUMBER] …`.  The casing is one function (`zulipTag` in `server/zulip/format.ts`).
- **Budgets and the loop guard.**  Peer wakes are capped per bot per hour (default 6) and per topic per hour (default 2).  After 4 peer wakes in one topic with no message from Jay there, the topic stops waking the bot until Jay speaks in it.  Owner wakes have their own hourly cap (default 30).  Peer messages older than 30 minutes (backfill after an outage) do not wake; Jay's do.  The rolling spend ceiling holds peer work, never Jay's.
- **Keys stay out of reach.**  A key lives only in the session and in the Authorization header.  It never enters `process.env`, so no spawned CLI inherits it, and every client error is scrubbed of it.  The auto-approve sensitive list cards any read of `~/.secrets/` or a `*-zuliprc` file, so one bot cannot read another role's key without Jay approving it.

## Restarts and Outages

State is kept per bot in `~/.botfleet/zulip/<botId>.json` (mode 600): a message-id cursor, a ring of handled message ids, the units still waiting, and the budget ledgers, all written in one atomic write.

- The first connection starts from the newest message; history is not a wake.
- On `BAD_EVENT_QUEUE_ID` (Zulip dropped an idle queue), the session re-registers at once and backfills `is:dm` and `is:mentioned` above the cursor.
- De-duplication gates on the cursor as it stood when the queue was registered, plus the ids this connection has already seen, never on the live cursor: Zulip can deliver a lower id after a higher one, and that message still wakes.
- A long poll that times out, or a connection something cut, polls the same queue again; Zulip answers `BAD_EVENT_QUEUE_ID` if it is gone.  The poll timeout is the queue's own `event_queue_longpoll_timeout_seconds` plus 10 seconds.  Any other failure re-registers, and the old queue is deleted first, so reconnects never leave orphaned queues on the realm.
- A unit waiting when the harness stops is still there after it restarts, and a message already handled is never dispatched again.
- Connection failures back off 5, 30, 60, then 120 seconds, and the backoff resets only when a poll returns.  A missing credential file, a refused key (401) or a refused role disables that bot alone; the others keep running, and the slow reconcile (every 5 minutes, and on every Settings save) retries it.
- A unit nobody could start for 6 hours (a stopped bot) is dropped.

## Setup

Do these in order.  Nothing below runs until `zulip.enabled` is `true`.

1. **Keys.**  Each BF bot already exists on the realm (owner-created).  Put each bot's zuliprc in one folder, named `<Role>-zuliprc` (`BF-Plumber-zuliprc`), mode 600:

   ```ini
   [api]
   email=bf-plumber-bot@simplewithus.zulipchat.com
   key=<the bot's API key>
   site=https://simplewithus.zulipchat.com
   ```

   On Jay's Mac these files are in `~/.secrets/Zulip/`.  See Open Decisions: BotFleet does not read that folder until the owner names it in `zulip.credentialDir`.
2. **Subscriptions.**  An event queue delivers only channels the bot is subscribed to.  Subscribe each BF bot to the channels where it should be woken (the fleet guide's Bot Setup step 5).  BotFleet does not subscribe bots itself.
3. **Bot ids.**  `GET http://127.0.0.1:8799/api/bots` lists each bot's `id`.  The mapping is by id, never by display name.
4. **Jay's user id.**  From Zulip (his profile, or `GET /api/v1/users`).
5. **Settings.**  Save the section with `PUT /api/config` (or edit `~/.botfleet/config.json`).  Start with `dryRun`:

   ```json
   {
     "zulip": {
       "enabled": true,
       "dryRun": true,
       "ownerUserId": 123456,
       "credentialDir": "~/.secrets/Zulip",
       "bots": {
         "<plumber bot id>": { "role": "BF-Plumber" },
         "<fixer bot id>": { "role": "BF-Fixer" }
       },
       "postChannels": ["agent-sync", "builds"]
     }
   }
   ```

   A save starts, stops or rebinds sessions at once.  It never reloads providers or interrupts a turn.
6. **Check.**  `GET http://127.0.0.1:8799/api/zulip/status` shows each bound bot's state (`connected`, `reconnecting`, `disabled` with a reason), its Zulip user id and how many units are waiting.  It never shows a key or message text.  In `dryRun`, the server log prints `[zulip] BF-…: dry run — message N would wake (owner|peer)` for each mention or DM, and nothing else happens: no turn starts (units saved by an earlier live run wait), the Zulip tools are not offered, and nothing is posted.
   - **Verify the owner rule before going live.**  From the Zulip app on the phone or the desktop (not a script), @-mention one bound bot in a channel it is subscribed to.  The log must say `would wake (owner)`.  If it says `not woken (owner_via_api)`, the realm is not reporting a human `client` on Jay's messages: stop, and set `ownerClients` to the client name the realm reports, or report it.  The `client` field is read from the message the way the fleet listener reads it, and it has not been checked against this realm from BotFleet.
7. **Go live.**  Save `"dryRun": false`.

Other settings: `autoReply` (`"final"` or `"off"`), `staleMinutes`, `peerDmAllow` (bot user ids), `budgets` (`peerWakesPerHour`, `peerWakesPerTopicPerHour`, `ownerWakesPerHour`, `peerChainLimit`), `realm`, `ownerClients`.

Environment overrides, for tests and soak rigs: `OMB_ZULIP_REALM`, `OMB_ZULIP_CREDENTIAL_DIR`, and `OMB_ZULIP_DISABLE=1` (a kill switch, read at boot and on every reconcile: with it set, no session runs).

## One Listener per Bot

Zulip delivers every event to every queue registered for a user.  If two processes hold queues for the same BF bot, both answer.  So:

- Do not list BF bots in the AI-Fleet-Coordinator `agent-sync` listener daemon config.
- One data folder holds one harness: BotFleet already refuses a second harness on the same `~/.botfleet` (`harness-owner.json`), so the live harness is the only one that reads its `zulip` section and its `zulip/` state.
- A harness on a different data folder (`OMB_DATA_DIR`, a dev or test rig) reads its own config.  If that config binds the same BF roles, it opens a second queue for each and both answer.  Leave `zulip` out of that config, or start it with `OMB_ZULIP_DISABLE=1`.
- Two BotFleet bots bound to the same role are refused at reconcile.

## Tools

| Tool | Lanes | Target |
| --- | --- | --- |
| `zulip_reply {content}` | MCP and HTTP | The conversation that woke this turn |
| `zulip_post {channel, topic, content}` or `{dm_user_id, content}` | MCP and HTTP | The origin, a `postChannels` channel, or the DM sender |

Both are offered only to a bot whose Zulip session is connected, never in a dry run, and only on a turn that may speak for the bot: a Zulip turn (or a continuation of one), or a turn Jay is attending in BotFleet.  Webhook, iMessage, Linq, routine and job turns, and a peer-invoked (`ask_bot`) turn, get neither.  On the MCP lane the agents proxy publishes them when the harness sets `OMB_ZULIP=1`, the turn's comms grant carries the same bit, and `/api/internal/zulip/{reply,post}` refuses a grant without it and takes the caller's identity from the grant, never from the arguments.  On the HTTP lane the tool host bakes the identity in at dispatch.

## Tests

`server/zulip/*.test.ts` run against `server/testing/fake-zulip-server.ts`, a `node:http` fake with real event queues, Basic auth, `BAD_EVENT_QUEUE_ID`, mention flags computed outside code and quotes, and 429 injection.  `pnpm vitest run server/zulip` runs them; `pnpm test` picks them up with the rest.

## Open Decisions and Follow-Ups

- **D0, credentials (owner).**  `AGENTS.md` ("Secret Handoff") and `docs/secrets.md` say the product server does not read fleet handoff files.  The zuliprc files are runtime copies of the Infisical keys, but `credentialDir` therefore has no default: the file source is off until the owner sets it.  If the owner confirms that reading `~/.secrets/Zulip` is allowed, amend those two documents in the same change.  The planned second source is Infisical (the keys sit in the "AI Fleet Coordinator" project, `/zulip`; BotFleet's vault reads only the "BotFleet" project today).
- **Tag casing (owner).**  The harness writes `[BF-PLUMBER]` per the seat-tag rule; the fleet guide's example shows `[BF-Deployer]`.
- **Model downgrade (owner).**  Zulip turns are unattended, so `unattendedModelDowngrade` moves them to the cheaper model, as it does for webhooks.  Background jobs have an owner ruling that exempts them; Zulip has none yet.
- **Owner messages and stopped bots.**  Jay's Zulip messages run unattended and do not wake a bot he stopped in BotFleet.  Lifting either needs an owner ruling.
- **Routine posts (owner).**  Scheduled and manual routine runs do not get the Zulip tools, even though their prompt is Jay's own.  If a routine should post to Zulip (a daily digest), that needs a ruling: mount them for `schedule` and `manual` runs, or card any post that does not go to an origin.
- **Not built yet.**  Rollover for long-lived Zulip conversation tasks (routine tasks have it), topic re-keying on resolve, a Settings panel, `zulip_read_topic`, ack reactions, the Infisical credential source, and keeping a reply binding across a harness restart (a turn recovered after a restart does not auto-reply).
- **Director** has no Zulip bot, so it cannot be bound.
- **Seat prompts** (`bots/_shared.md`, `server/seat-prompt.ts`) still tell bots to post to Slack.
