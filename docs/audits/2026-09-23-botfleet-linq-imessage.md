# 2026-09-23 — BotFleet Linq iMessage Integration

> Owner-flip on the iMessage transport.  On 2026-09-23 Jay reversed the
> prior recommendation (`Photon`) and chose Linq instead.  Author: MM
> ([MINIMAX]) in the `minimax/linq-imessage` lane.  Closes board
> `9c415bb589124389b133e4072d694101` (P2).

## Context

BotFleet ships two iMessage surfaces today:

1. The Mac relay (`~/apps/botfleet-imessage-relay.py`, LaunchAgent
   `com.jay.botfleet-imessage-relay`) watches the local `chat.db` from
   a dedicated `agentchat@icloud.com` Apple ID and routes messages
   through `POST /api/bots/{id}/messages` with `source: "imessage"`.
2. The harness reply path that strips the `[to iMessage]` tag and
   echoes outbound text back through the relay (`shared/imessage-message.ts`).

That setup is reliable but it owns your Mac and your Apple ID.  The
`aphant AI` recommendation Jay has been considering — Photon's
free-for-10-users tier — is a clean SaaS swap, but the recommended
Linq tier has the same Mac-relay shape with a real phone number,
proper iMessage routing, and zero local infrastructure to babysit.

This lane adds Linq as a parallel iMessage transport.  Per-bot
configuration picks which transport (off / mac-relay / linq) routes each
thread.  No existing bot is changed silently: every installed install
treats `transport` as `off` until the operator opts the bot in.  Only
the workspace default (when the operator creates a fresh Director bot)
defaults to Linq; everything else stays off.

## Plan

1. Ship the Linq v3 partner-API client as a thin, dependency-free
   wrapper.  No module-level mutable state, every request accepts an
   `AbortSignal`, errors are typed — raw `Response` objects never cross
   the boundary.
2. Wire a webhook receiver at `POST /api/webhooks/linq`.  HMAC-SHA256
   verification against `LINQ_WEBHOOK_SECRET`; falls through when no
   secret is configured (Linq hobby tier makes signing opt-in).
3. Refactor the Mac relay's inbound path into a shared `ingestInbound()`
   core, so Mac and Linq share prompt wrapping, typing flag, mark-read,
   and bot routing without parallel implementations.
4. Add per-bot transport choice (`botDefaults.imessagePerBot[botId]`) and
   a workspace-level Linq binding (`imessageLinq`) that carries phone
   number, sender policy, and voice-tool consent.  Stored values only —
   tokens come from `process.env`.
5. Ship a `send_voice_message` tool.  Pipelines MiniMax TTS through the
   first-party hosted driver (PR #519), uploads the resulting mp3 to the
   signed URL Linq returns, and ships it as an iMessage audio
   attachment.  Gates on `ctx.linq` so an unconfigured bot cannot burn
   TTS quota.
6. Add a `LinqSettings` panel under Settings → Workspace → Integrations.
   Phone number, sender chips, voice toggle, per-bot dropdown,
   tunnel-url instructions, and a "send self-test" button.
7. Document the ngrok / Cloudflare Tunnel path for local webhook
   development without auto-launching either.

## What Shipped

| File | Purpose |
|------|---------|
| `server/linq/types.ts` | inbound/outbound shapes, webhook payload types, transport config types |
| `server/linq/client.ts` | v3 REST wrapper: 11 endpoint functions, typed errors, env-aware config |
| `server/linq/dispatch.ts` | inbound routing, sender policy, shared ingest core |
| `server/linq/client.test.ts` | every endpoint exercised, happy + error paths |
| `server/linq/dispatch.test.ts` | bot binding, sender policy, empty-payload guard, rejection paths |
| `server/routes/linq-webhook.ts` | HMAC-verifying webhook receiver |
| `server/routes/linq-webhook.test.ts` | signature verification, lifecycle events, dispatch handoff |
| `server/tools/linq.ts` | `send_voice_message` tool executor (TTS → upload → send) |
| `server/tools/linq.test.ts` | binding on/off, voice toggle on/off, success path |
| `src/components/LinqSettings.tsx` | workspace panel + per-bot dropdowns + test button |
| `src/components/LinqSettings.test.tsx` | token masking, test-button dispatch, dropdown wiring |
| `server/config.ts` | `imessageLinq` block + per-bot `imessagePerBot` map |
| `server/index.ts` | route registration, dispatch wiring, config-status fan-out |
| `server/tools/registry.ts` | `LINQ_VOICE_MESSAGE` tool record, `linq` gate field |
| `server/tools/host.ts` | executor merge for `send_voice_message` |
| `server/config.test.ts` | imessageLinq schema persistence + per-bot map migration |

## Field-Name Provenance

Every field name in the integration is from one of three authoritative
sources, listed inline in the code with a short citation.  The full
table the audit relies on:

| Endpoint | Field | Source |
|----------|-------|--------|
| `POST /v3/chats/{chatId}/messages` | `message.parts[]`, `parts[].type="text"\|"media"`, `parts[].value`, `parts[].attachment_id` | [linq-team/ai-agent-example README](https://github.com/linq-team/ai-agent-example) |
| `POST /v3/attachments` | `content_type`, `filename`, `size_bytes` + response `attachment_id`, `upload_url`, `required_headers` | [linq-team/ai-agent-example README](https://github.com/linq-team/ai-agent-example) |
| `POST /v3/chats/{chatId}/read` | (no body) | [apidocs.linqapp.com](https://apidocs.linqapp.com) |
| `POST /v3/chats/{chatId}/typing` | (no body) | README |
| `DELETE /v3/chats/{chatId}/typing` | (no body) | README |
| `POST /v3/messages/{messageId}/reactions` | `operation`, `type`, `custom_emoji` | README |
| `POST /v3/chats/{chatId}/share_contact_card` | shape TBD by Linq dashboard | dashboard form, follow-up |
| `GET /v3/contact_card?phone_number=...` | response `name`, `photo_url` | dashboard |
| `GET /v3/chats/{chatId}` | response `handles[]`, `is_group`, `display_name`, `service` | README |

The audit's standing rule: never invent a field name.  When the docs
are ambiguous, the surface ships, but the ambiguity is listed in Open
Questions below and a placeholder mock is wired in the test.

## Verification

Run from `~/apps/botfleet-mm-linq-imessage`:

```bash
pnpm typecheck            # tsc -b + tsc -p tsconfig.server.json — green
pnpm test                 # vitest run: client/dispatch/webhook/tools tests green
git grep -E 'LINQ_API_TOKEN\s*=\s*"'   # zero matches — no leaked secrets
```

Manual smoke:

1. Set `LINQ_API_TOKEN=test-token` in `.env.local`.
2. Start the harness; navigate to Settings → Workspace → Integrations.
3. Enter the bot's phone number, save, observe "Linq token detected."
4. Run an ngrok tunnel: `ngrok http 8800`.
5. Point the Linq dashboard webhook at `${ngrok-url}/api/webhooks/linq`.
6. Send a text to the configured number; expect the dispatched bot to
   answer (tagged `[to iMessage]` per the existing convention).
7. Click "Send test message" in the panel; expect a green chip with
   the partner-API `message_id`.

PR gate that the lane keeps green:

- typecheck (renderer + server)
- vitest for `server/linq/*`, `server/routes/linq-webhook.test.ts`,
  `server/tools/linq.test.ts`, `server/config.test.ts`, and
  `src/components/LinqSettings.test.tsx`
- `git grep` for the literal token string is the audit's leak check.

## Rollback

Single-feature revert:

```bash
git revert --no-edit <merge-sha>            # full lane
git revert --no-edit <sha-of-individual-c>   # any single commit during review
```

Per-feature drill-down if a partial-only revert is needed:

| Scope | Files to revert |
|-------|-----------------|
| Remove the webhook surface only | `server/routes/linq-webhook.ts`, `server/index.ts` (`/api/webhooks/linq` and `/api/test/linq-self-message` registration) |
| Disable the `send_voice_message` tool | remove `LINQ_VOICE_MESSAGE` from `HARNESS_TOOLS`, drop the executor merge in `server/tools/host.ts`, drop `LinqToolContext` from the call site |
| Drop Linq from the config schema | `server/config.ts` schema deltas, `server/index.ts` `configStatus()` block, `src/state/store.tsx` `imessageLinq` field |
| Hide the Settings panel | remove `<LinqSettings>` from `SettingsModal.tsx`; the rest stays inert |

After any revert, run `pnpm typecheck && pnpm test` to confirm no
stray references.

## Future Work

- **Paid Linq tier.**  Hobby tier is sales-gated for higher volumes and
  MMS / RCS / group-chat reactions.  Toggling the tier is a single
  config flag plus the dashboard subscription page.
- **MMS / RCS.**  Each new endpoint (image group messages, read
  receipts) lands as a small additive change to `client.ts`.
- **Group chat reactions and iMessage apps.**  Same surface shape as
  `linqAddReaction`; the audit's open question below flags the one
  field-name question to verify on the API doc.
- **Signed upload URL refresh.**  The signed S3-style URL Linq returns
  expires; we cache the credentials inside one tool call only.  A
  future PR can introduce a TTL-aware retry path.
- **HMAC-required mode.**  Today a missing `LINQ_WEBHOOK_SECRET`
  accepts unsigned calls.  Add a required-on-publish toggle in the
  Settings panel once the dashboard surfaces a "publish webhook with
  signing" button.

## Open Questions

1. **Contact-card share payload.**  `linqShareContactCard` accepts an
   opaque payload today; the README points at the dashboard form but
   does not document the JSON.  Confirm via `apidocs.linqapp.com`
   before the dashboard ships.  (Tracked; no production call lands
   until verified.)
2. **`message.received` group chat `service` field.**  When Linq
   dispatches an SMS-as-iMessage thread, the `service` field may be
   `sms`.  We surface this in the inspector; the inbound router does
   NOT refuse SMS today.  Closing this loop is a follow-up after a
   paid-tier migration.

## Apple ID / Privacy Ruling

This lane does NOT modify outbound iMessage routing on Jay's Mac.  The
2026-09-02 ruling (outbound iMessage MUST go through the `agents` Mac
account, never `jay`) still governs the Mac relay.  Linq is a separate
SaaS API on Linq's servers, with its own phone number identity.  The
two transports stay parallel; cross-talk happens only when the operator
flips a per-bot dropdown.

## Notes For Reviewers

- The Mac relay was not touched.  Its directory, LaunchAgent, and
  Python file stay at `~/apps/botfleet-imessage-relay.py` unchanged.
- Tokens never appear in this PR.  `LINQ_API_TOKEN` and
  `LINQ_WEBHOOK_SECRET` are read from `process.env` only.
- No Apple ID credentials appear in this PR, on disk, or in any log.
