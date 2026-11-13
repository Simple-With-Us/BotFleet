# 2026-09-08 — Webhook cards + fleet-infra Sentry to Plumber

## Context & Objective

Board P1 `28f76152`.  Owner: fleet-infra Sentry should go to Plumber, not Fixer.  Webhook data should render as a collapsible card like a tool-run fold, not a blue user bubble.

The live Sentry webhook (`Sentry Incident Webhook → Fixer`) is one org-level integration URL.  135 of 207 recent deliveries were `fleet-infra`; those were waking Fixer.

## Changes Made

- Webhook dispatch reads the Sentry issue `project.slug`.  `fleet-infra` reroutes to the bot named Plumber and drops Fixer's configured prompt so Plumber is not told it is Fixer.
- Other Sentry projects stay on the assigned bot.
- Chat (web and iOS) detects the harness webhook wrappers and paints a left-aligned collapsible card.  Headline is the issue title when present.  The untrusted JSON is behind Details.  Not `bg-bubble-user` / not iMessage-blue.

Touched files:

- `server/webhooks.ts`
- `server/index.ts`
- `server/webhooks.test.ts`
- `src/lib/webhook-message.ts`
- `src/lib/webhook-message.test.ts`
- `src/components/WebhookCard.tsx`
- `src/components/ChatView.tsx`
- `ios/Sources/CompanionCore/WebhookMessage.swift`
- `ios/Tests/CompanionCoreTests/WebhookMessageTests.swift`
- `ios/App/ChatView.swift`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-08-webhook-card-sentry-plumber.md`

## Decisions & Trade-offs

Did not split the Sentry integration into two webhook URLs — one org hook is what Sentry sends.  Routing is payload-based.  Did not add a settings UI for project routes.  Did not change message `kind` (that would drop historical webhook turns from the model transcript).  No TestFlight extra-ship.

## Verification State

```
pnpm exec vitest run src/lib/webhook-message.test.ts server/webhooks.test.ts src/lib/ui-copy.test.ts
cd ios && swift test --filter WebhookMessageTests
```
