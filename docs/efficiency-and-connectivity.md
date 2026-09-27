# Efficiency And Connectivity

Short operator notes for keeping BotFleet wakes cheap and the Mac harness
connected.  Related Antigravity lanes:  PR #532 (Sentry/PagerDuty/GitHub payload
slim, ingress filter, trigger-gap fold, resume-cursor clear) and PR #533
(cheaper models for unattended work, 180s timeout treated as silence).

## Model Selection

Prefer BotFleet native `modelSelection` engines for day-to-day bot work.  Each
bot's configured engine is the default path for schedules, webhooks, and chat.

`seat-mcp` (`grok`, `grok-tui`, `deepseek` only) is optional for rare Mac
Grok/DeepSeek jobs — not a general spawn bus.  Composer and `cursor-agent` are
not `seat-mcp` seats; do not route ordinary bot automation through them.

## Events Over Polls

Prefer event webhooks and resource-triggers when the upstream emits an event.
Keep cron-style schedules for ledgers, coverage gaps, and work with no reliable
push source.

Webhook ingress now slims known providers before prompts are built:

- GitHub, Sentry, and PagerDuty (PR #532)
- Coolify/deployment-style payloads and App Store Connect notifications
- Generic JSON depth/key/array budgets for everything else

Unattended turns may downgrade to cheaper catalog entries when the bot allows
it (PR #533).  A 180s provider timeout is treated as silence, not a hard
failure, when the bot is unattended.

### Unattended Request Ceiling (MiniMax)

Separately from the silence-treatment above, `server/drivers/minimax.ts` gives
an unattended turn a 900s per-request ceiling (the turn's own wall-clock
budget) — PR #625, following up on board row bf77b434 (BOTFLEET-V), where the
Compiler bot's CI-webhook turns were repeatedly cut off at 180s mid-answer.  A
CONNECTION that goes fully silent is still caught much sooner than 900s by a
separate idle-stall guard (`STREAM_IDLE_TIMEOUT_MS`, 120s of no bytes from
the reader) that fails the round as a retryable `provider_error` rather than
riding the full budget.

### Interactive Round Budget (HTTP Lane)

The fixed 180s interactive ceiling is gone.  Every HTTP-lane driver
(`grok.ts`, `minimax.ts`, `openai-compat.ts`) now takes the shared
`runTurnLoop` budget in `server/drivers/chat-completions/loop.ts`: a HARD
ceiling of 600s on one model round, however live its stream is, plus an IDLE
clock of 120s that every chunk off the socket re-arms.  A slow reasoning
round that keeps streaming runs to the hard ceiling; a silent connection ends
in 120s.  The idle expiry is terminal for the turn, not a retried transient,
so a first byte that never arrives after a tool call ends the turn at 120s.
Unattended MiniMax turns keep `readChunkOrStall` as their only idle guard
(`requestIdleMs: 0`) until the shared clock has run in production.

## Harness Self-Heal

The always-on LaunchAgent runs `~/apps/botfleet-server-start.sh` against the
detached checkout at `~/apps/botfleet-server`.  This repository ships a tracked
copy at `scripts/botfleet-server-start.sh`.

Behavior:

1. If `127.0.0.1:8799/health` is already good → exit 0 (no second harness).
2. If `node_modules` is missing (or `yaml` is absent) → run **once**
   `pnpm install --frozen-lockfile`, log clearly, then start.
3. Rate-limit:  if an install was attempted within the last 15 minutes (stamp
   file `$ROOT/.botfleet-heal-stamp`), exit nonzero with a loud message instead
   of looping.
4. Optional `--heal-only` runs the install path without starting the server.
5. `scripts/botfleet-server-healthcheck.sh` is a thin curl probe for scripts
   and monitors.

To adopt the tracked script on a Mac after merge:

```bash
install -m 755 scripts/botfleet-server-start.sh ~/apps/botfleet-server-start.sh
install -m 755 scripts/botfleet-server-healthcheck.sh ~/apps/botfleet-server-healthcheck.sh
```

Point the LaunchAgent `ProgramArguments` at `~/apps/botfleet-server-start.sh`
if it still references an older copy.

## Thread Reuse On Wakes

PR #470 merged primary-thread reuse for wakes.  Webhook and routine dispatch
both go through `RoutineManager` with `defaultThread` wired from the bot's live
`threadId` in Simple mode (the default).  Wakes append to the conversation the
user is already viewing instead of minting sibling tasks.

## Sentry Black-Box Probes

Sentry uptime/black-box HTTP checks for Socratic.Trade must target the canonical
health URL:

`https://socratictrade.com/api/health`

Do not point probes at redirect-only hostnames.  `socratic.trade` redirects;
it is not the probe target.
