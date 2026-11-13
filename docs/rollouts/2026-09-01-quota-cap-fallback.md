# Rollout — quota and session-limit failover

**Why:** Owner 2026-09-01: anytime a bot hits a usage cap or quota, BotFleet should use that bot's saved fallback model.  Director (grok-4.6) in room BotFleet.app returned `You've hit your session limit · resets 12:10am (America/Chicago)` after tools.  The configured fallback (`antigravity` / `gemini-3.1-pro-high`) never ran.

**Seat:** BF-Director.  **Worktree:** `~/apps/botfleet-director-quota-fallback`.  **Branch:** `grok/quota-cap-fallback`.  **Board:** `96f2ec55`.  **Issue:** #118.  **Do not push `main`.**

## What landed

- Quota, usage-cap, and session-limit chips force the saved fallback chain even when tools already ran (`tool.ok === true`).
- The same gate runs for 1:1 and room turns.  Rooms still re-enter via `pendingMemberFallback`.
- Chain entries that match the current primary instance+model are skipped so a same-model fallback cannot loop.
- `classifyError` treats session-limit / usage-cap as terminal `quota` so the same engine is not retried.
- Unconfigured engines are not auto-picked (spend).  A bot with no distinct saved fallback still stops.

## Honesty

README and botfleet.app now say quota/session-limit failover is automatic.  Other streamed error paths stay in review.  This is not a claim that every 401/5xx path is established.

## Follow-up (not this PR)

- Auto-revert to the original primary after the advertised reset time.
- Same-model fallback rows in Settings (Oracle's opus→opus, Director's second grok-4.6) still do nothing useful; skip is the safety net, not a Settings cleanup.
- AG `ag/model-failover-gemini-qdrant-rag` auto-picks another registered engine when no chain exists.  That is extra spend.  Left out.

## Verify

- `pnpm exec vitest run server/model-fallback.test.ts server/drivers/retry.test.ts`
- `pnpm typecheck`
- `node apps/site/build.mjs`
