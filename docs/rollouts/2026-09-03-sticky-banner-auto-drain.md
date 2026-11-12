# 2026-09-03 — Sticky 8799 banner, calendar Auto, curl|python3 -c

Seat: GROK.  Branch `grok/sticky-8799`, worktree `~/apps/botfleet-grok-followups`.  Board `6251b088`.  Follows #175.

## Why the banner stayed

The always-on harness on 8799 was healthy (`GET /api/health` 200).  The packaged app's UI shim on 18799 returns 502 JSON `BotFleet harness on port 8799 is not reachable` when a proxy attempt fails at launch.  `state.error` never cleared after SSE `connected: true` or a later hydrate, so the top bar stayed red.  #175 retried GET/HEAD once; this change dismisses that specific banner once the harness is actually answering.

## Calendar Auto

Scheduled routine ticks used the owner's saved prompt, then `markUnattended`, so Auto mode never answered.  Webhooks and resource triggers stay unattended (untrusted payload).  Calendar ticks now honor Auto mode; destructive/sensitive still card.

## curl | python3 -c

`looksDestructive` treated any `curl | python3` as download-and-run.  Fleet bots parse JSON with `curl | python3 -c 'import json...'`, which kept Publisher on a Local computer approval for a health check.  Inline `-c`/`-e` is now allowed; `curl | python3` with no `-c` still cards.

## Copy

Scheduled routines continue the previous task thread.  Webhooks and resource triggers still mint a fresh task.

## Verification

```bash
pnpm exec vitest run src/state/store.test.ts server/auto-approve.test.ts server/routines.test.ts
```

138 tests passed locally.  Desktop banner clear needs a packaged rebuild after merge (`~/apps/update-botfleet.sh`).
