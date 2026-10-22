# Prompt Prefix: Stable And Volatile Halves

Every turn's system prompt is assembled once, by `server/system-prompt.ts`, from
tagged parts.  The joined text is byte-identical to the single string the direct
lane and the room lane used to concatenate by hand; what changed is that each
part is now labelled, and two of those labels matter to the drivers.  Ported from
OpenMausBot PR #1758 (building on #1031); board row 58984b3d.

## Why

A provider's prompt cache, and a warm Claude CLI process, are both keyed on the
bytes that lead the request.  Before the split, saving a memory or tagging a
teammate changed the one system string, which changed the Claude driver's spawn
contract (`argsKey`), which relaunched the CLI with `--resume` and made the
provider re-upload the entire conversation at the cache-write rate.  The HTTP
drivers had the same problem one layer down: a changed system message re-priced
the tools, instructions, and transcript the endpoint had already cached.

## The Boundary

A section is **volatile** when its text legitimately differs between two turns of
one live conversation.  `VOLATILE_SECTIONS` is `memory`, `mentions`, `outstanding`,
and `recent` (upstream's ids; BotFleet emits the first two today, so a later port
of the other two lands on the right half), plus BotFleet's own
`skill-instructions`, `playbooks`, and `automation`.  Skill instructions and
playbooks are selected from trigger terms in the message being sent, and the
automation note names what triggered this one turn, so all three change between
turns of one session; on the stable half, the first message with a new trigger
term would relaunch the Claude CLI and re-upload the cached conversation.
Everything else is the **stable** half: persona, computer and connected-app
sentences, the Chief roster and status capsule (byte-stable across a busy flip
since PR #617), section context, the skills index, and provenance.

`SendTurnInput` carries `system` (the whole prompt, unchanged), `systemStable`,
`systemVolatile`, `volatileDigest` (sha256 of the volatile half), and `mentionTurn`
(true when the user tagged teammates, so an unchanged mentions note is still
delivered because it describes this very message).

## Delivery

| Driver | Stable half | Volatile half |
|---|---|---|
| Claude CLI | `--append-system-prompt`, hashed into `argsKey` | Inside the user turn as a `<system-reminder>` block, only when the native session has not carried this exact copy, or on a mention turn |
| Grok, MiniMax, OpenAI-compatible | The system message | Prepended to the newest user message on every request (the stored transcript never contains a delivered note) |
| Codex, ACP engines | The whole `system` string, as before | Same; a later package moves them to receipts |

The Claude driver remembers what each native session carries as a **receipt**
(`server/drivers/prompt-split.ts`): one small file per session id under
`DATA_DIR/prompt-split/`, holding the fingerprints of both halves.  A receipt is
written only after the CLI accepts the turn (its first frame after submission),
so a process that dies before reading stdin has carried nothing.  A transient
relaunch forgets the receipt and re-delivers the note, since the dead CLI may not
have persisted it; a repeated note costs a few hundred bytes, a skipped one loses
the memory for the rest of the session.  Receipts outlive their sessions and are
swept after 30 days.  A cleared volatile half is announced once, then later turns
go bare.

## Telemetry

Each turn books `promptBytes` (UTF-8 bytes of each half) and forwards them to
Usage Monitor as `metadata.promptStableBytes` and `metadata.promptVolatileBytes`,
two flat numbers, because the v2 metadata bag accepts only primitives.  Read them
against `cachedInputTokens` to see whether the prefix is actually being cached.
