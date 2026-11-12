# Fallback Walk And Codex Catalog — 2026-09-30

Board row da11b074 (owner bug: a fallback chain that stops on a stale model, and a Codex picker that lists ids Codex does not serve).

## What Was Wrong

**The walk stopped on the dead entry.**  A saved fallback such as `claude-3-7-sonnet` is passed to the Claude CLI verbatim.  The CLI does not fail the process for an unknown model.  It answers with a synthetic assistant frame (`model: "<synthetic>"`, top-level `error: "model_not_found"`, zero usage) and a result frame with `api_error_status: 404`.  The driver forwarded the apology as bot text, `turnProducedAssistantOutput` counted it as real output, and `selectTurnFallback` returned nothing.  On Deployer's thread that was 24 of 26 fall-overs ending on the apology, with `gpt-5.6-luna` and `MiniMax-M3` behind it almost never reached.  A model rejection also recorded nothing, so every new user turn walked to the same dead entry again.

**A fail-over that could not start ended in silence.**  `startTurn` throws before dispatch (instance gone, effort not offered) or reports a dispatch failure through `onDispatchError`.  Neither emits `turn.completed`, so nothing advanced the walk.  The only trace was a `console.error`.

**The Codex list was BotFleet's own.**  `readCodexModelCatalog` used the app-server probe or, when the 8 s probe failed under host load, `STATIC_CODEX_MODELS`.  `CodexDriver.refreshModels` then replaced a previously good live list with the static one and the registry persisted it.  The static rows named `gpt-6-sol` and `gpt-6-luna`, which no Codex catalog offered.

## What Changed

### Claude Driver (`server/drivers/claude.ts`)

- A synthetic assistant frame with `error: "model_not_found"` becomes a `runtime.error` row, never `assistant_text`.  The message names the model and says to pick another in Settings.  It carries no `setup` flag, so the bot is not marked dead.
- The result frame settles the turn `ok: false` with the distinct stop reason `unknown_model`, which `server/drivers/retry.ts` already classifies as terminal.  A bare 404 result with no output is treated the same way.
- A text backstop (`/^There's an issue with the selected model/`) covers a CLI that drops the `error` field.  It only fires on a short, synthetic or zero-output frame, so a real reply that opens with those words is kept as an ordinary message.

### Fold And Walk (`server/model-fallback.ts`, `server/index.ts`)

- `turnModelRejectionEvidence` reads the stop reason first and the LAST bot text second, only for a turn that already failed.  The fold treats it as "no output", so the walk continues.  It reads the last text, not the slice, because the slice accumulates across attempts.
- A per-(bot, engine instance, model) mark lives in the new `server/model-rejections.ts`, with a six-hour TTL, persisted to `model-rejections.json`.  `selectTurnFallback`, `resolveModel` and the automatic-failover candidate list all skip a marked entry.  A chain whose every entry is marked ends visibly instead of looping.
- The mark is not the doomed breaker (keyed without a model, so it would black-hole every healthy entry on that engine) and not a quota cooldown (the Usage settings would show it as a quota hit).
- A mark ends early on a successful turn on that model, a provider reload, or the engine being deleted.
- `launchFallbackTurn` replaces the `console.error`-only catch.  A fail-over that cannot start posts a `Couldn't start …` notice and moves to the next usable entry.  A chain with nothing left says so and fails the routine run that was waiting on it.  An error that is not about the engine (an update quiescing, providers reloading) is shown once without walking the chain into it, and a newer turn that already owns the bot is left alone.

### Codex Catalog (`server/drivers/codex-catalog.ts`, `codex.ts`)

The official rows now come from the first of these that answers:

1. the installed app-server's `model/list`;
2. the last live answer this instance saw;
3. the CLI's own `models_cache.json`, read-only, only `visibility: "list"` rows, slug, label and efforts;
4. BotFleet's static rows, each marked with an `Unverified` chip and a tooltip.

`refreshModels` never replaces a confirmed list with the static one.  A failed probe now logs why (timeout, rpc error, closed, empty) once per change, and `OMB_CODEX_CATALOG_PROBE_MS` raises the 8 s budget for a slow host.  The probe budget itself is unchanged.

## Owner Decision: GPT-6 Sol And Luna

`STATIC_CODEX_MODELS` named `gpt-6-sol` and `gpt-6-luna` since #538 and #539.  This change removes them, along with `gpt-5.3-codex-spark`, and lists the ids Codex reported as visible on 2026-09-30 (CLI 0.154.0): `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`.  Evidence: the CLI's own cache and the catalog the app-server returns from an empty home carry those five and neither GPT-6 row.  Luna stays the static default, on `gpt-5.6-luna`.

That proves the rows are not offered to this CLI version, not that they are unservable.  The Codex CLI is being upgraded.  When a newer Codex serves `gpt-6-luna` or `gpt-6-sol`, the live catalog lists them with no BotFleet release, and no saved selection is migrated here.  Whether a saved `gpt-5.6-luna` should become "Latest Luna" is the model-lineage lane's decision.

## Verification

- `server/model-fallback.test.ts`: rejection evidence, the walk with and without the mark, `resolveModel` routing, the registry.
- `server/drivers/claude.test.ts` with a fake CLI in four new modes: structural frames, text-only, a bare 404, and a real reply that only sounds like a rejection.
- `server/drivers/codex-catalog.test.ts`: live, last-good, cache file and static sources, the driver keeping a confirmed list through a failed probe.
- `server/index.test.ts`: a chain with a rejected entry walks to the healthy one and skips the rejected entry on the next turn; a fail-over that cannot start posts its notice and keeps walking.
