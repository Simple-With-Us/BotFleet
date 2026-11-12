# 2026-09-03 — Harness banner, Publisher drain, thinking chip, routine threads

Seat: GROK.  Branch `grok/owner-followups`, worktree `~/apps/botfleet-grok-followups`.  Board `6251b088`.  Issue #174.

## Why iOS still showed OpenMausBot

TestFlight does not upload on merge.  Last successful BotFleet iOS ship was 2026-08-29 (`~/.cache/ios-fleet/last-ship-botfleet.txt`).  The trio icon landed on main in #165 on 2026-09-03.  A TestFlight upload from `~/apps/botfleet-grok-tf` @ origin/main is in flight so testers get the new 1024 RGB icon.

## Harness 8799 banner

The desktop window talks to the UI shim on 18799, which proxies `/api` to the always-on harness on 8799.  A failed proxy returns `BotFleet harness on port 8799 is not reachable` and the app pins it in the top error bar.  The harness was listening (`app: botfleet`, pid 85412).  GET `/api/bots` also printed `BOT MESSAGES:` for every bot on every hydrate, flooding the log.

Fixes: remove that debug log; retry GET/HEAD once through the shim and the renderer `api()` helper on 502.

## Publisher

Live routine `44705752-98f6-43b0-bfde-4619cdae9a4f` renamed to **CT review queue drain**.  Count-only instructions are gone.  Every queue item must be analyzed and published or resolved, then any systematic gap in Congress.Trade should be fixed so the next filing would have auto-published.  A run was queued after the PATCH.

## Product

- Thinking row: model mark + italic model name to the right of `Thinking · Ns`.
- Later ticks of the same scheduled routine reuse the previous task thread when it still exists.  Webhooks still mint a live-chat task.
