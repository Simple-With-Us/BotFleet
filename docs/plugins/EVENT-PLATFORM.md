# Plugin Event Platform (Host API v2)

BotFleet plugins graduate from cards and commands to event-driven
integrations: a user installs an optional plugin, configures it in the
BotFleet UI, and the trusted host delivers typed events and executes
the plugin's routing decisions.  The first complete integration is
Zulip wake routing (`docs/plugins/zulip-plugin/`); the same framework
fits other chat platforms and useful integrations later.

```
Zulip realm ──DM/mention──▶ BotFleet host ──envelope──▶ plugin sandbox
     (outgoing webhook       │ listener, auth,       │ onEvent returns a
      or native queue)       │ canonical fetch,        routing decision
                             │ dedup, budgets      ◀───┘
                                     │ validated + executed by host
                                     ▼
                              dispatcher inbox wake
                              (or thread continuation)
```

## What lives where

Host (trusted, always on):

- Transports: the 8800 webhook listener, the per-bot Zulip event
  queues, credential checks, and canonical message fetches.
- `shared/plugin-events.ts`: the versioned envelope, subscription,
  routing-decision, and outcome contracts.
- `server/plugin-events.ts`: the bus — subscriber matching, per-plugin
  dedup rings, bounded serial queues, backoff retries, dead-letter
  queue, and a durable per-plugin ledger.  Event state lives here, so
  a plugin process staying alive retains nothing.
- `server/plugin-secrets.ts`: the secret and settings broker.  Secret
  values are write-only and host-held; settings validate against the
  manifest; upgrades auto-migrate.
- `server/zulip/hub.ts` `routeMessage`: claims ownership
  synchronously so concurrent lanes converge, awaits a bounded plugin
  decision, routes valid dispatcher targets onto their own session
  (budgets, coalescing, bindings, auto-reply intact), and falls back
  to the legacy direct wake otherwise.  Events are never silently
  dropped.
- `server/index.ts`: chat-summary provider (metadata only, no
  transcripts), the late-decision handler, and the
  settings/health/test-event/drain routes.

Plugin (untrusted, optional, sandboxed):

- `botfleet-plugin.json`: `events.subscribe`, `chat.read`,
  `dispatch.wake` capabilities; `eventSubscriptions`; user `settings`
  with write-only `secret` types.
- `plugin.mjs`: `onEvent` (policy + routing decision), `getHealth`,
  optional commands.  No ports, no credentials, no long-lived process.

## Capabilities

| Capability | Grants |
|---|---|
| `events.subscribe` | Receive typed host events for declared subscriptions. |
| `chat.read` | Scoped conversation summaries (metadata + counts, no bodies) attached to events. |
| `dispatch.wake` | Return `requestWake` decisions the host validates and executes. |
| `connector.reply` | Reserved: replies sent through approved host connectors. |

Manifest coherence is validated at install: subscriptions need
`events.subscribe`; `includeChats` needs `chat.read`.  At runtime the
host re-checks every gate, so a hand-edited manifest gains nothing.

## Event envelope

`{ eventId, type, source, occurredAt, receivedAt, refs, mentions,
content?, context }`.  Stable ids (`zulip:<account>:<messageId>`)
key dedup across the native queue and webhook lanes.  `content` is
canonical host-fetched text, present only when the subscription asks
for it; `context.chatSummaries` is present only with `chat.read`.
Decisions are `{ action: "requestWake" | "none", targetBotId?,
continueThreadId?, confidence?, rationale?, replyHint? }` — no other
action exists.  Outcomes are reason codes (`delivered`, `duplicate`,
`retry`, `deadLetter`, `failed`, `refused`, `disabled`,
`noSubscription`); event text never reaches logs or health views.

## Lifecycle

Install lands disabled.  Enable validates the host-API gate and loads
the sandbox; subscriptions activate from the registry flag.  Disable
stops deliveries (the ledger stays inspectable).  Update stashes broker
state across the tree rewrite, re-validates, reloads when enabled,
and auto-migrates settings with warnings (`added …`, `dropped …`).
Downgrades refuse — roll back with remove plus reinstall.  Remove
clears the ledger and broker state.  A crashed or timed-out handler
fails its delivery alone; the next call respawns the child.

## Writing an integration

1. Copy `docs/plugins/zulip-plugin/` as a starting point.
2. Declare capabilities, one `eventSubscriptions` entry per source,
   and `settings` (plain knobs; `secret` for anything sensitive).
3. Implement `onEvent({ event, host })`: read `host.settings`,
   apply your policy, return a decision.  Treat `event.content.text`
   and your own `replyHint` as untrusted input.
4. Implement `getHealth({ host })` for the manager's health panel.
5. Install from the folder, configure, enable, send a test event,
   watch the health panel, then remove or keep.

## Troubleshooting

- `noSubscription`: the event matched no declared subscription —
  check `source`/`kinds` in the manifest.
- `refused (capability)`: the decision needs a capability the
  manifest lacks — add it, reinstall, re-enable after review.
- `retry` then `deadLetter`: the sandbox crashed or timed out
  repeatedly — check the plugin code path for that event shape, then
  POST the plugin's `drain` after fixing.
- `duplicate`: the same platform message arrived twice — expected
  when the native queue and webhooks converge; exactly one wake ran.
- Legacy fallback (`no plugin decision, legacy wake` in the log):
  the plugin declined, timed out, or named an unknown target, so the
  mentioned bot woke directly.  Nothing was dropped.

## Compatibility policy

Host API v2 retains the full v1 surface: v1 manifests (`botfleet:
"1"`, `"^1.0.0"`, `">=1"`) load unchanged, and cards/commands work as
before.  Unknown capabilities fail closed.  Settings migrations run
automatically on `settingsVersion` bumps; anything smarter waits for
a plugin `migrateSettings` export (not yet wired — the host does the
predictable parts today).
