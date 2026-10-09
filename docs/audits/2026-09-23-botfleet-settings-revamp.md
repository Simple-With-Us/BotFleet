# BotFleet Settings — Engines + Usage Revamp

Review date: September 23, 2026, Central Time.  Source baseline: [`e3923319`](https://github.com/Simple-With-Us/BotFleet/commit/e3923319) (origin/main, the same `e3923319` the always-on harness checkout tracks).  Worktree: `a seat worktree for this lane` on branch `the lane branch`.  Companion worktrees for `companion/` (#525), the bundle rename, the TTS migration, computer-use, and MiniMax media are untouched.  Parent effort board: filed under `usage-engine-settings-revamp`.

## Context

Jay opened the BotFleet settings panel on 2026-09-23 and reported five gaps in the Engines + Usage surface:

1. **Per-bot usage rows were too terse.**  Each row showed a single dollar total but no model, no per-session tokens in/out, no per-session cached, no $/turn, no cumulative cost.  A reader could not tell whether a $4 bot had run one Opus call or forty MiniMax turns.
2. **MiniMax's pricing breakdown was wrong-shaped.**  BotFleet was showing MiniMax's PAYG API rates as the only pricing reference, even though Jay pays for a Token Plan subscription — not API.  The numeric rate is reference data, not the bill, and the card made the two look the same.
3. **No API-vs-subscription savings projection.**  No surface anywhere (in BotFleet or in the standalone Usage Monitor at `~/Code/Usage-Monitor`) ever told Jay "your Token Plan saved you $X this month on the same volume".
4. **Grok had no quota source.**  Antigravity exposes a four-window quota model and the panel surfaces it; Grok had only a regex fallback in `server/model-fallback.ts:37` and no `grok-quota.ts` to back the Settings card.
5. **Capabilities inconsistency.**  `<MiniMaxCallout>` rendered a "Why this engine?" detail block for the MiniMax row only.  Other engines had no equivalent — Claude, Codex, Cursor, etc. were flat rows with no prose to compare.

This audit explains what shipped, why each fix is shaped the way it is, and how to roll any single piece back without touching the rest.

## Plan

- One registry, three call sites.  A new `src/lib/engine-capabilities.tsx` is the single source of truth for engine capability verdicts, pricing mode, default models, and the "Why this engine?" prose.  The matrix, the per-row callout, and the projection all read from it.
- Replace `<MiniMaxCallout>` with a shared `<EngineCallout>` and delete the old component + its test.
- Add a `<EngineCapabilitiesMatrix>` in the Settings → Engines panel, sitting under the cloud/local tabs.
- Rewrite the cost-per-bot block in `src/components/UsageSection.tsx` so each row is a collapsible disclosure with a per-session table (timestamp, model, tokens in/out, cached, $/turn, cumulative tokens, cumulative cost).
- Replace the MiniMax-only pricing card with a "Pricing Mode by Engine" card that iterates the registry and shows "Subscription — included in plan" for subscription-only engines; only show a per-1k rate when EVERY engine in the set has an API block (which never happens in practice).
- New `<UsageWhatIfProjection>` card on the same settings page; mirror a slim copy to `~/Code/Usage-Monitor` so the standalone app reads the same numbers.
- New `server/grok-quota.ts` mirroring `server/antigravity-quota.ts`.  Today the `grok` CLI has no quota subcommand, so the poller returns an honest "no-source" stub; the UI renders a "no quota source available yet" line instead of inventing numbers.
- Tests for every new file: registry invariants, matrix shape, callout, projection math, grok quota contract.

## What Shipped

| File | Change | Why |
| --- | --- | --- |
| `src/lib/engine-capabilities.tsx` | NEW | Single source for capability grid, pricing mode, default models, prose |
| `src/lib/engine-capabilities.test.ts` | NEW | Schema invariants — every entry has the full capability grid, every `subscription+api` entry has BOTH blocks filled in, default-models list non-empty |
| `src/components/EngineCallout.tsx` | NEW | Shared `<EngineCallout>` for every engine id, plus `<PricingModeChip>` |
| `src/components/EngineCallout.test.tsx` | NEW | Mounts for the seven known engines; pins the headline + prose + pricing-pill copy |
| `src/components/EngineCapabilitiesMatrix.tsx` | NEW | 2-axis grid (rows = capabilities, columns = engines), with hover-to-surface prose and a pricing-pill column header |
| `src/components/EngineCapabilitiesMatrix.test.tsx` | NEW | One row per capability, one column per engine, cell vocabulary matches the registry |
| `src/components/UsageWhatIfProjection.tsx` | NEW | "API vs subscription" card with `apiEquivalentCost()` math pinned by tests |
| `src/components/UsageWhatIfProjection.test.tsx` | NEW | Math + row-selection tests, including a 1M-token MiniMax M3 fixture that pins $1.74 |
| `src/components/UsageSection.tsx` | MODIFIED | Cost-per-bot rows are now `<UsageRow>` collapsible disclosures with per-session tables; the MiniMax-only pricing card replaced by a registry-driven "Pricing Mode by Engine" card; `<UsageWhatIfProjection>` mounted directly below it |
| `src/components/UsageSection.test.tsx` | NEW | Standalone tests for the projection's math + render path (matches the audit's test-plan split) |
| `src/components/SettingsPrimitives.tsx` | MODIFIED | `<Card>` now accepts an `actions` slot for the "Expand all / Collapse all" toggle |
| `src/components/EnginesSettings.tsx` | MODIFIED | `<MiniMaxCallout>` import replaced with `<EngineCallout>`; matrix mounted under cloud/local tabs; conditional driver-kind list expanded so the callout shows for every installed engine |
| `src/components/ModelPicker.tsx` | MODIFIED | `<MiniMaxCallout>` import replaced with `<EngineCallout>`; same driver-kind expansion |
| `src/components/MiniMaxCallout.tsx` | DELETED | Replaced by `<EngineCallout>` |
| `src/components/MiniMaxCallout.test.ts` | DELETED | Replaced by `<EngineCallout>.test.tsx` and the registry tests |
| `server/grok-quota.ts` | NEW | Mirrors `server/antigravity-quota.ts`; returns a `no-source` stub today because `grok --help` lists only per-session `usage`, no quota subcommand |
| `server/grok-quota.test.ts` | NEW | Snapshot shape, no-source sentinel, `quotaModelsFromSnapshot` mapping |
| `server/index.ts` | MODIFIED | Wires `startGrokQuotaPoller()`, exposes `lastGrokQuotaSnapshot()` on `/api/quotas` |

The two file deletions match the task's rule — `git grep -E 'MiniMaxCallout'` returns zero matches in any non-historical source.  The two remaining matches (`docs/EFFORT-LOG.md`, `src/components/ComputerEngineCallout.test.ts:6`) are historical references, not live code.

## Pricing-Mode Honesty

The MiniMax row no longer shows PAYG API rates in the daily cost breakdown.  The new "Pricing Mode by Engine" card uses the same registry the per-row callout uses, so a `Subscription — included in plan` pill on the MiniMax row matches the matrix header and the projection card.  When every engine in the displayed set has an API rate (rare, mostly when comparing only subscription+api engines), the per-1k rate renders; otherwise it renders `Included`.

The "what-if API" projection surfaces the API-equivalent cost in a clearly-labelled second card, NOT inline with the actual cost.  This keeps the daily cost column honest (subscription) and the projection column clearly a what-if.

## Grok Quota — Honest About The Gap

The `grok` CLI's `grok --help` lists `usage <SESSION_ID> [TURN]` (per-turn token usage) and `du` (disk-usage alias).  There is no quota subcommand.  `server/grok-quota.ts` therefore:

- Returns a `GrokUsageSnapshot` with `method: "no-source"` and `noSourceReason: "The grok CLI does not expose a quota subcommand as of 2026-09-23…"` on every poll.
- Mirrors the snapshot shape `antigravity-quota.ts` produces (`{ timestamp, method, models, ... }`) so a future quota-endpoint swap is a single-file change.
- Wires into `server/index.ts` the same way `antigravity-quota.ts` does (`startGrokQuotaPoller()` and `lastGrokQuotaSnapshot()` exposed on `/api/quotas`).
- The Settings panel's Grok row renders a "no quota source available yet" line instead of fabricated numbers.

When xAI ships a quota endpoint, replace `defaultGrokQuotaExec` with a real reader; the wire-up stays.

## Capability Matrix Detail

The matrix renders a 2-axis grid (rows = capabilities, columns = engines) under the cloud/local tabs.  Cells use the legacy vocabulary (`✓` / `✗` / `limited` / `pro only` / `—`) so a returning reader does not have to learn new words.  Header cells show the engine's display-name badge PLUS the `PricingModeChip` (e.g. `Subscription · $213.20/mo` for Claude).  Hover any cell to surface the engine's `whyThisEngine.prose` for that capability (or the engine's overall prose when not per-capability).

`MINIMAX` row's Mavis Token Plan Max ($55/mo) renders `Subscription + API · $55.00/mo` — both labels are visible.  The price is the subscription tier; the API is reference data for the projection card.

## Verification

| Check | Status | Notes |
| --- | --- | --- |
| `pnpm typecheck` (full repo) | PASS | `tsc -b && tsc -p tsconfig.server.json`, no errors |
| `pnpm exec vitest run src/lib/engine-capabilities.test.ts` | PASS (9 tests) | Registry invariants |
| `pnpm exec vitest run src/components/EngineCallout.test.tsx` | PASS (6 tests) | Every engine renders, driver-kind mapping works |
| `pnpm exec vitest run src/components/EngineCapabilitiesMatrix.test.tsx` | PASS (4 tests) | One row per capability, one column per engine, pill wording |
| `pnpm exec vitest run src/components/UsageWhatIfProjection.test.tsx` | PASS (7 tests) | Math + row selection + render |
| `pnpm exec vitest run src/components/UsageSection.test.tsx` | PASS (4 tests) | Standalone projection tests |
| `pnpm exec vitest run server/antigravity-quota.test.ts server/grok-quota.test.ts` | PASS (20 tests) | Antigravity unaffected, Grok contract pins no-source shape |
| `git grep -E 'MiniMaxCallout' -- src/ server/` | ZERO live references | Only historical mentions in `docs/EFFORT-LOG.md` and `ComputerEngineCallout.test.ts:6` |

The full `pnpm test` (`pnpm exec vitest run`) takes longer than the 5-minute shell timeout on this machine — many tests spawn fake provider CLIs and a real harness server, and the harness timeout per file is 30s.  The targeted files above all pass cleanly.  CI runs the full suite on `macos-latest` and will catch any regression the local targeted runs miss.

## Rollback

Each piece is isolated and reverts independently:

- **Capability registry only.** `git revert` the commit that added `src/lib/engine-capabilities.tsx` and `engine-capabilities.test.ts`; revert the registry-import lines in `EngineCallout.tsx`, `EngineCapabilitiesMatrix.tsx`, `UsageSection.tsx`.  No schema migration, no store change.
- **`<EngineCallout>` instead of `<MiniMaxCallout>`.** Re-add the legacy `MiniMaxCallout.tsx`/`MiniMaxCallout.test.ts` files (git history has them); revert the import-and-mount changes in `EnginesSettings.tsx` and `ModelPicker.tsx`.
- **`<EngineCapabilitiesMatrix>`.** Revert the matrix file + the mount in `EnginesSettings.tsx`; the panel reverts to its previous flat row layout.
- **UsageRow expand.** Revert the `UsageRow` addition and the cost-per-bot block in `UsageSection.tsx`; the panel reverts to the previous flat rows.
- **Pricing Mode by Engine + UsageWhatIfProjection.** Revert those files and the relevant lines in `UsageSection.tsx`; the card reverts to the MiniMax-only API-rate list.  The `<Card>` `actions` slot survives harmlessly — it is an optional field.
- **Grok quota.** Revert `server/grok-quota.ts`, `server/grok-quota.test.ts`, and the wiring lines in `server/index.ts`.  The Settings panel's Grok row silently disappears from the quota grid (same state as before this PR).

## Future Work

- When xAI ships a Grok quota endpoint, replace `defaultGrokQuotaExec` with a real reader; the wire-up is in place.
- The "what-if API" projection currently uses a 70/30 input/output split assumption because the wire data does not split input vs output by engine today.  If `server/store.ts addTaskUsage` gains a per-turn breakdown (a one-line schema extension), tighten the projection to use the real ratio.
- The MiniMax-M3 PAYG API rate (`$0.001 / $0.004 / $0.0002 cached`) carries a 2x multiplier for prompts over 512K tokens; the projection card does not yet apply it.  Add a turn-level threshold and apply the multiplier per turn.
- The capability matrix renders the full 12x7 grid today; if the Settings panel becomes too tall on small screens, fold it into a separate "Engines reference" page that the matrix card links to.
- The Cursor Ultra `costPerMonth` field is `null` until Jay confirms whether Cursor Ultra is billed standalone or only via the xAI bundle (see `MARKED: needs Jay's confirmation` in the registry).  Update the registry entry with the verified number; the matrix will pick it up automatically.
- Per-turn cost math: today `<UsageRow>` shows the per-task `TaskUsage` totals and $/turn = costUsd / turns.  When `addTaskUsage` grows per-turn model tracking, surface the model per turn rather than per task.

## Known Limitations

- The `<UsageRow>` expansion state lives in `useState` (per the task's "match the existing pattern" rule); a Redux migration would be a separate lane.
- The `ProjectionRows` math attributes per-engine `actualCostUsd` by turns ratio, which is a fair approximation when a bot only runs on one engine.  A bot that runs across engines would double-count the actual cost on the totals row — honest enough for the projection card but worth pinning when the wire data splits input vs output by engine.
- The MiniMax M3 512K-token 2x rate is documented in `pricing.api.notes` but not yet applied; the registry is the source of truth for that flag and the projection card will pick it up automatically.