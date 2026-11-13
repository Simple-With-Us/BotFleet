# 2026-09-01 — Resource-threshold triggers

> **2026-09-22 [MM] archaeology note:** this rollout predates the 2026-09-22 bundle-ID migration; the `com.jay.botfleet-server` LaunchAgent label referenced below is the historical one and stays verbatim.  The live label is now `app.botfleet.server` (see `docs/rollouts/2026-09-22-bundle-id-migration.md`).  The Restart step below now reads "Restart `app.botfleet.server`".

## Why

Jay asked for a BotFleet mechanism that wakes a bot when disk, RAM, or CPU crosses a threshold, as part of moving Housekeeper off Grok Bot.

## What landed

- `ResourceTriggerManager` samples this computer every 30 seconds while BotFleet is running.
- Metrics: disk free (GB), disk used (%), RAM used (%), swap used (%), 1-minute load.
- Automations → Resources tab.  Same queued task executor as webhooks/routines.  Cooldown per trigger (default 45 minutes).
- Phone companion cannot create these (same as webhooks).
- Mac launchd `com.jay.mac-resource-watch` still POSTs the Housekeeper webhook if you want coverage while the desktop app is closed.

## Verification

- `vitest run server/resource-triggers.test.ts companion/test/routes.test.ts` — 60 passed
- Live Housekeeper webhook `Housekeeper resource pressure` created on the running 8799 server (launchd path).  In-app sampler is 404 until this build is the running harness.

## Follow-ups

- Restart `com.jay.botfleet-server` onto this branch after merge so the Resources tab and `/api/resource-triggers` are live.
- Default Housekeeper triggers (disk ≤80G, swap ≥80%, load ≥16) can then be created in the UI.
