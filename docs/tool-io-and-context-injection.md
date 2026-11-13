# Tool Input And Output, And Context Injection

Two questions a person asks about a bot's turn that the transcript could not
answer: what exactly did this step take and return, and what did the harness put
in front of the model that I did not type.  Both answers now live in one bounded
per-thread side store and are fetched only when a row is opened.

## The Constraint

The transcript is the one store every client holds in full: the renderer keeps
every message of every thread.  A tool row therefore carries a headline (a
clipped target and one clipped line of result) and nothing more.  A 35.7 MB
`routines.json` wedged the harness in September 2026, so nothing unbounded is
ever added to a message, a task or the main store.

## What The Existing Logs Hold

Checked before adding anything:

- The canonical event log (`events/<threadId>.ndjson`) carries the full JSON
  `arguments` for the HTTP engines only.  No engine's result is in it:
  `item.completed.detail` is one clipped line.
- The native tee (`native/<threadId>.ndjson`) has the provider's whole protocol,
  but in each provider's own shape, at up to 64 MB per thread, with no
  provider-neutral key to find one step by.

So there is a new, small log: `item-io/<threadId>.ndjson`.

## The Side Store

`server/item-io-store.ts`.  One record per captured input, output or injected
text, keyed by the step's item id (and turn id, for engines that reuse small ids
across turns).

- Drivers attach a bounded `io` capture to `item.started` and `item.completed`
  (`shared/item-io.ts`: Claude, Codex, ACP engines, Pi, Antigravity, the Box
  runner and the HTTP tool loop).  The headline fields are unchanged.
- `EventBus.publish` moves the capture into the store and strips it, so the wire,
  the subscribers and the event log never carry it.  An HTTP engine's full
  `arguments` are filed as the input with no driver change, once when the step
  starts and again at completion only if the string changed (a streamed first
  fragment, settled later).
- Each field is cut to 32 KB with a `truncated` flag and the original length.
  A thread keeps one live file and one rotated generation of 6 MB each
  (`ITEM_IO_LOG_MAX_BYTES`), trimmed at boot, swept when the thread is orphaned
  for a week, and deleted with the bot, task or room.
- Redaction is the wire's pass (`redactSecretsInText`), run before the cut when a
  record is written and again when one is read.  Nothing the wire would hide is
  served.  A structured input also gets the event log's TREE pass when it is
  captured (`prepareInput` in `shared/item-io.ts`), before it is flattened to
  text: that is what masks a `{"name": "OMB_COMMS_TOKEN", "value": "…"}` env
  entry by its name, which no text pass can see once the object is a string.
  The same walk cuts each long string leaf to the capture limit before the
  regexes or `JSON.stringify` see it, so capturing a `write_file` with a
  multi-megabyte body costs a bounded amount of work on the harness's one thread.
- The write path is the event log's bounded append queue: it drops its oldest
  entries before it grows, never blocks the publisher, and a failed write costs
  one step its expanded view, never a turn.  A failing disk is reported once
  per outage (the first failure, with its reason), counted while it lasts, and
  summarised when a write next lands, so a full disk does not flood the log.
- An ACP agent may announce a call with an empty or partial `rawInput` and send
  the arguments on a later `tool_call_update`.  The driver files them as soon as
  they are new text for that call: on an `item.updated` while the call runs, or
  on the `item.completed` when they only settle there.  The store keeps the
  newest input per step.

`GET /api/threads/:id/items/:itemId/io[?turnId=]` answers `{ itemId, turnId?,
at, input?, output?, text? }` where each field is `{ text, truncated, length }`,
or 404 when nothing was recorded.  It has the events route's gate: the thread
must be one the harness knows.

A tool row in the chat, and a step in the Trajectory list, read it when opened.
Until it arrives, or when it was never recorded (a message from before the store
existed, or one that rotated out), the row shows the clipped headline it always
had and says which it is.

## Context Injection

What the harness adds to a prompt that the person did not type, found by reading
`startTurn` and the builders it calls:

| Source | What it is | Recorded |
|---|---|---|
| `memory` | the bot's MEMORY.md, after the standing guidance | when it first appears and when it changes |
| `skill` | bundled skill instructions a trigger term selected | every turn it applies |
| `playbook` | installed playbook instructions the message selected | every turn it applies |
| `automation` | the note naming which automation fired the turn | every turn it applies |
| `mention` | the nudge to bring in a tagged teammate | every turn it applies |
| `handoff` | the conversation replayed to an engine with no session of its own: one that joined mid-thread, or (Codex) whose native session was lost and was rebuilt from the replay | every turn it applies |
| `rewind` | the surviving conversation replayed after an edit or version switch | every turn it applies |
| `reply` | the earlier message a reply quotes | every turn it applies |
| `continuation` | the note the harness sends as the whole turn when a card is finished (a connector connected, a credential provided or declined) | every continuation turn |

A message dispatched more than once (a model fallback hands it to the next
engine) records a draft only the first time: one that matches a recorded one by
source, size and preview is dropped before it is published, so neither the chat
nor the Trajectory shows it twice.  A draft that differs, such as a replay the
second engine alone needed, is kept.

A card continuation has no stored message, so its rows hang under the last
message on the active path (the card the person just finished, or the bot's last
reply).  The Codex lost-session replay is only known to the driver, which calls
`onReplayRecovered` on the turn it was handed so the harness can record it.

Not recorded, on purpose:

- The standing prompt sections (identity, computer, connected apps, recall
  guidance, tool budget, team, credentials, routines, section context, owner
  notes, skills index) are the bot's definition and identical every turn.  A row
  per turn would bury the ones that explain a change.
- Recall is a tool the model calls; its results are tool output and already a
  step with an input and an output.
- Attached files are tags in the message the person typed, and webhook and
  resource payloads are the stored `system` message, both already visible.
- A transcript-replaying engine's own history is the conversation, not an
  injection.
- Steering lines are typed by the person; compaction is the provider CLI's own
  and never passes through the harness.
- Room turns use a separate dispatcher and GroupView.

Each record is a source, a redacted one-line preview and a size.  It travels as a
`context.injected` runtime event (so the Trajectory lists it as a CONTEXT step,
ahead of the turn it began) and as a short `contextInjections` list on the user
message that started the turn (so the chat shows a quiet "Context injection ·
memory" row under it).  The full text goes to the side store under the event's
item id.  The row appears with the tool calls setting.
