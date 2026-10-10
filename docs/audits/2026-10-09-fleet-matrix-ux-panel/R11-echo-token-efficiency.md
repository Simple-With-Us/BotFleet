# Token Efficiency: The Plumbing Is Good, The Owner Cannot See It Or Aim It

Seat: Echo.  Lens: token and cost efficiency.  Evidence at origin/main `4e296b8c`, by code and docs only, no billing data.  No R1-R7 paper covers this (grep of the panel directory for token, plugin and MCP: no hits).

## Verdict

The cheap wins are already shipped.  What is missing is aim.  The harness can keep a prompt cacheable and slim a webhook, but the owner cannot set a budget for one bot or see whether caching is working.

## What Already Works

- **Stable and volatile prompt halves.**  Memory, mentions, skill instructions, playbooks and the automation note ride in the volatile half so the cacheable prefix stays byte-identical (`docs/prompt-prefix.md`, section "The Boundary").  The Claude driver keeps per-session receipts so a changed note does not relaunch the CLI.
- **Webhook slimming.**  GitHub, Sentry, PagerDuty, Coolify-style and App Store Connect payloads are cut before a prompt is built, and unknown JSON gets depth, key and array budgets (`docs/efficiency-and-connectivity.md`, "Events Over Polls").
- **Cheaper models for unattended turns.**  `unattendedModelDowngrade` (`server/model-fallback.ts:89`) rewrites the selection when the bot allows it.
- **Bounded side stores.**  Tool input and output are cut to 32 KB a field and 6 MB a thread, outside the transcript (`docs/tool-io-and-context-injection.md`).  The skills index is capped at 15 entries and 16,000 bytes, with an omission report (`server/skills.ts:40-47`).
- **A real fleet ceiling.**  `spendCeilingUsd` stops dispatch at a rolling 5-hour figure, and refuses to act when fewer than half of settled turns carry a price (`server/config.ts:441-453`).  That honesty about unpriced turns is unusual and right.

## Gaps

1. **Cache health is measured and never shown.**  Each turn books `promptStableBytes` and `promptVolatileBytes` to Usage Monitor (`server/telemetry.ts:331,393`; `server/index.ts:4677`).  The doc says to read them against `cachedInputTokens`.  I found no reader of those two fields in `src/` (grep: none).  The Usage screen shows cached input (`UsageSection.tsx` imports `cachedInput`), but not the prefix size or whether it changed between turns.  An owner cannot tell a cold prefix from a warm one.
2. **The ceiling is fleet-wide and off by default.**  The config comment says why (`config.ts:441-445`): a stopped unattended fleet is worse than an overspend.  The consequence is that one runaway routine cannot be capped without capping everything.  I found no per-bot or per-routine budget in `server/` or `shared/` (grep for ceiling and budget names; not exhaustive).
3. **Two engine families still get the whole prompt.**  The doc's delivery table sends Codex and ACP engines "the whole `system` string, as before", with receipts promised for "a later package".  Those engines see the volatile half re-sent every turn.  How much that costs: unverified, it needs the byte telemetry from gap 1.
4. **Injected context is shown in bytes, not tokens.**  `ContextInjectionRows.tsx` prints sizes like "412 B".  That is honest, and it is the wrong unit for the money question.
5. **Skills index cap is silent in the app.**  Past 15 skills later ones drop from the prompt, and the omission list is served only by a route (`server/index.ts:13798`).  Whether the UI surfaces it: unverified.

## Positions

- Turn the telemetry already collected into one row per bot on Usage: prefix bytes, volatile bytes, cached share.  No new server work.
- Add a per-bot and per-routine rolling cap that pauses that bot and posts a Needs You item, never the whole fleet.  It should reuse the ceiling's priced-share rule.
- Move Codex and ACP engines onto receipts before adding engines, since each new engine repeats the cost.

## Ranked Recommendations

1. **S:** Show prefix size and cached share per bot on the Usage screen from fields already booked.
2. **M:** Per-bot and per-routine spend cap that pauses one bot and raises a Needs You item.
3. **L:** Receipts for Codex and ACP engines so the volatile half is not resent.

## The Owner's Decision

When a bot hits its own cap, should it pause and ask, or quietly fall back to a cheaper engine?  The first protects the budget and interrupts work.  The second keeps work moving and hides the spend.
