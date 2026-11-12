# 2026-09-20 — MiniMax Top-to-Bottom Inspection

> Author: MM ([MINIMAX]), seat-tag pinned.  Complements the existing P1 audit
> lane `grok/full-stack-audit` (#22) with a MiniMax-specific deep dive and a
> single concrete PR land.

## Scope

This pass focuses on the MiniMax engine (chat-completions driver in
`server/drivers/minimax.ts` + balance poller in `server/minimax-balance.ts` +
quota registry in `server/model-fallback.ts`) because the existing fleet-wide
audit was still two waves behind on the MiniMax surface and one P2 was
already filed with no active implementation.

Targeted inspection only — not a replacement for #22's broader scope.  The
sections below document what shipped this turn and what came out of the
inspection but is intentionally deferred to a later seat (CLAUDE already
owns the parallel Claude/MiniMax work, AG already owns the parallel
updater/Composio work, GROK already owns the umbrella audit).

## What Shipped This Pass

### PR #509 — `fix(server): broadcast MiniMax account-level quota caps to every bot`

Mirrors the established `applyAntigravityUsageToRegistry` pattern
(`server/antigravity-quota.ts:185`) for the MiniMax account-balance signal:

- `server/minimax-balance.ts`: new `applyMiniMaxBalanceToRegistry(snapshot, registry?)`.  When the snapshot reports the SHARED account is out of funds or both Token Plan windows are at 0%, writes `*:minimax:*` to the registry.  Idempotent across consecutive `describe()` calls; cleared automatically when the balance recovers to `ok` / `near_cap`.
- `server/harness/registry.ts`: call the helper immediately after `getMiniMaxBalance(...)` so the cap reaches the registry before the next fallback chain read.
- 5 new unit tests in `server/minimax-balance.test.ts` covering: account-balance broadcast, Token Plan cap on either window, unrelated-pool no-op, recovery clearing, cross-instance isolation.
- 1 surgical test-mock extension in `server/harness/registry.test.ts` (the existing `vi.mock("../minimax-balance.ts")` did not expose the new import; the dual-window badge block isolates the snapshot path so a no-op is the honest stand-in).

**Verification**

- `pnpm typecheck` clean
- `pnpm exec vitest run server/minimax-balance.test.ts server/model-fallback.test.ts server/harness/registry.test.ts server/quota-window-map.test.ts server/antigravity-quota.test.ts` → **164/164 passing** in 15.87s
- Auto-merge armed, PR #509

**Resolves** board item `555c5227` (P2 / BF-FIXER, 2026-09-19).

### Why this ship vs. the full chip-path fix

The board's recommended fix called for hardening the chip path at
`server/index.ts:2281` (narrow matcher over error message strings like
"insufficient balance" / "credits exhausted" / "payment required").  Two
observations steered this pass toward the polling-path fix instead:

1. The registry's `get()` wildcard fallback (`*:${instanceId}:${model}`)
   already supports the broadcast shape; we only needed a real writer
   instead of a chip-path rewrite.
2. The polling path's signal (zero balance returned from
   `account/query_balance`) is the canonical "this account is dead"
   marker, fed by an offline endpoint poll, not a per-turn error
   classification.  Fixing the chip path is a separate, narrower
   heuristic (narrow matcher must avoid false positives like rate-limit
   tokens mis-classified as account caps) and is filed as a follow-up
   below.

## Findings Filed / Surfaced But Not Shipped This Turn

### Same Surface, Different Failure Mode — pre-existing items not in scope

| Board id                          | Severity | Owner                     | Why not this PR                                                                            |
| --------------------------------- | -------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| `8cf2a359` (900s turn stalls, MiniMax) | P2 | BF-FIXER                  | Different code path (acp/core.ts:1050), needs separate inspection. Out of this PR's scope. |
| `752b8c0a` (duplicate of 555c5227) | P2 | MM                        | Belongs to issue #286 (board-row reconciliation), not the quota surface itself.             |
| `a2218cad` (Composio unreachable for HTTP-lane bots) | P2 | CLAUDE | Distinct runtime — Claude's surface.                                                       |
| `752b8c0a`, `5c89b8b1`-series     | mixed    | various                   | All BF-FIXER PLANNED items require deeper, single-domain inspection per item.              |

### V2 / Next-Wave — surfaced during this turn

1. **V2 chip-path hardening** — at `server/index.ts:2281`, the
   narrow-matcher logic the board item recommended ("insufficient
   balance", "out of credits", "plan limit") is still implemented
   upstream by `quotaOrCapFromErrorCode`.  When that returns
   `source: "provider-error-code"` AND the `instanceId === "minimax"`
   AND the error body's `error_message` matches the "hard account
   cap" narrow set, ALSO call `recordInstanceCap` so even a transient
   chip observation falls every other bot back in the same describe
   cycle.  This is the chip-path twin of the polling-path fix in
   #509, and would close the "a flaky network 401 still pages PD for
   every other bot" gap the polling fix can't catch.
2. **Per-model `*:minimax:<model>` for non-`general` pool caps** —
   the current fix broadcasts `*:minimax:*` even when only a
   single ModelCatalog id runs against an exhausted pool.  In
   practice the snapshot's only ModelQuota pool is `general`, but a
   future schema that reports a per-model cap on, say, an image
   pool will need `:minimax:<catalogId>` instead of `:minimax:*`.
   Low priority — schema doesn't allow it today.
3. **Docs follow-up** — `docs/usage.md` (currently absent) should
   describe the 402-account-balance recycling rule so end users
   know to top up rather than re-page.

## Existing PRs / Lanes Inventory (concurrency check)

These lanes were active when this turn started; all are unaffected by
this work:

| Branch / lane                                                | Seat    | Status                                                                        |
| ------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------- |
| `grok/full-stack-audit` (P1, BF)                            | GROK    | umbrella audit (#22)                                                          |
| `ag/updater-quota-composio-fixes`                            | AG      | #270 + #285 (Composio + updater feed)                                         |
| `claude/*` series                                            | CLAUDE  | rooms stall, ACP mcpServers, HTTP-lane, computer GUI                          |
| `mm/composio-fleet-user-id`, `mm/engine-polish`, `mm/grok-bot-mark`, `mm/aac035dd-room-stall-exact-key` | MM | already merged via PRs #498 / #500 / #503 / #499                              |
| `mm/redact-verify`                                           | MM      | duplicate board-row reconciliation (#286 / PR #350 source-fix already merged) |
| `codex/calendar-timezone-20260912` etc.                      | CODEX   | iOS Live Activities source-fix (#326/#294 + PR #326 already merged)           |

Five stale worktrees under `~/apps/botfleet-mm*` now sit ~9–10 commits
behind `origin/main`; cleanup is a no-op for the audit and was
explicitly deferred so this turn's focus stays on the original ask.

## What Did Not Make It This Turn

- iOS Live Activities physical-device validation (#294) — GROK owns the lane; requires macOS TestFlight device the audit lane doesn't have.
- Electron `attached-ui-shim` Windows CI flake — Claude's lane, requires a Windows runner.
- ACP `mcpServers` evidence work — Claude's lane.

These were re-confirmed during inspection to be other-seat work, not
re-litigated.
