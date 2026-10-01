# 2026-10-01 — MiniMax M3.1 Reasoning Effort On Harness (DSH)

Board row `873f0bbe`, branch `claude/dsh-m31-effort`.  Owner approval 2026-10-01: enable MiniMax M3.1 on the Harness (DSH) engine with the `settings.yaml` entry, a Harness change for effort levels plus this BotFleet bump, and one paid MiniMax call to confirm it works.  This follows `2026-09-30-minimax-m31-effort.md` (PR #756, MiniMax Code and the direct HTTP engine), whose "Harness (DSH): What Unlocks M3.1" section listed these three steps.

## What Ships

- **Harness (Clutch) #65**, merged as `2d57ec5`: `EffortLevel` gains `xhigh`, `dshSupport.perModelEffortLevels` publishes `MiniMax-M3.1-Flash-Preview: [low, medium, high, xhigh, max]`, `dshInstalledEffortLevels(settings)` narrows that to what an install's `settings.yaml` declares, and Default on a row with per-model levels sends dsh's provider-default value `""`.  Harness doc: `docs/dsh-reasoning-effort.md` in that repo.
- **BotFleet** pins `harness` to `github:jaywedgeworth22/Clutch#2d57ec5…` and:
  - `readDshModelCatalog` sets the M3.1 row's `effortLevels` from the installed settings, so the picker offers Default, Low, Medium, High, X-High and Max only when dsh will take them, and an explicit `[]` otherwise.
  - The DSH `configureSession` delegates to Harness instead of keeping its own copy.  The old copy returned early whenever a turn had no effort, which left a level an earlier turn pinned on a resumed session in force.
  - `isStockDshCli` becomes Clutch's `isDshEngineCli` (the same engine check, now also matching the `clutch` wrapper).

No UI code changes.  The web picker (`src/lib/model-effort.ts`) and iOS (`Instance.effortLevels(for:)` in `Models.swift`) already prefer a row's own list over the DSH MiniMax rule, so M3.1 shows the picker once its row carries levels and M2.7 Highspeed stays hidden.  Only the web rule's comment changed.

## Engine Matrix (DSH Column)

| Model | Harness (DSH) |
|---|---|
| **M3.1 Flash Preview** | Effort: Default, Low, Medium, High, X-High, Max, when `settings.yaml` declares them (this Mac does).  Wire: `session/set_config_option` `reasoning_effort` after the model switch.  pi-ai sends `thinking: {type: "adaptive", display: "summarized"}` plus `output_config: {effort}` to `api.minimax.io/anthropic`.  Default sends `""`, which omits the thinking field. |
| **M3** | Excluded, unchanged. |
| **M2.7 Highspeed** | No effort picker, unchanged (DSH MiniMax rule). |

## The Settings Entry

dsh 0.1.5-rc.2 (pi-ai 0.85.1) does not catalog M3.1, so it knows the model only from `llm-pi-ai.providers.minimax.models` in `~/.dsh/settings.yaml`.  On this Mac the entry already existed (added 2026-09-30) with `id`, `name`, `contextWindow` and `maxTokens`.  This lane added two fields and changed nothing else:

```yaml
reasoningEfforts: { low: low, medium: medium, high: high, xhigh: xhigh, max: max }
compat: { forceAdaptiveThinking: true }
```

Backup: `~/.dsh/settings.yaml.bak-202610010204` (`cp -p`, byte-identical to the file before the edit).  The YAML parses, every other key is unchanged, and dsh's own `dsh-llm-pi-ai` adapter, loaded offline against the edited file, resolves M3.1 with efforts low, medium, high, xhigh and max, no default effort, `compat.forceAdaptiveThinking: true`, `anthropic-messages` at `https://api.minimax.io/anthropic`.  The edit takes effect on dsh's next request, with no restart.

A machine whose entry lacks `reasoningEfforts`, has `reasoningEfforts: false`, or has no M3.1 entry at all gets no M3.1 picker: `dshInstalledEffortLevels` answers `[]` there, and that explicit `[]` wins over the static per-model map.

## What Default Does

A turn with no effort on M3.1 sends `reasoning_effort: ""`, dsh's "Provider default", which clears a level an earlier turn left on a resumed session.  pi-ai then sends no thinking field and MiniMax applies its own default.  The request is best effort: a route that declares its own default effort refuses `""`, and the turn then runs at the session's current level instead of failing.  DeepSeek rows still send nothing for Default, because their routes always declare a default effort and dsh refuses `""` for them.

## Behaviour Changes

- **Unattended runs start at Low.**  `unattendedModelDowngrade` stamps Low on unattended, webhook and resource-triggered runs whenever the selected model offers Low.  DSH M3.1 now offers it, so those runs start at Low instead of MiniMax's default, the same as M3.1 on MiniMax Code and the direct engine (see the 2026-09-30 doc).
- **The Clutch rename rides along.**  The pin moves past Clutch #60 through #64, so `dshSupport.displayName` (the default label for a DSH instance with no name of its own) is now "Clutch", and a DeepSeek picker id with no advertised catalog encodes to dsh's stock wire id (`DeepSeek-V4.1-Flash` → `deepseek-flash`, Clutch #63).  A turn that names no model therefore reports the stock wire id (`deepseek-flash`) as its session model.  Those test updates match PR #762.

## Verification

All tests use temporary homes and the fake ACP CLI.  No test reads `~/.botfleet` or contacts the harness on port 8799.

- Clutch #65: `npm run typecheck` clean, `npm test` 16 files and 150 tests, and CI green (verify, e2e, iOS Build, gitleaks).
- `server/drivers/acp/dsh.test.ts`: the live catalog offers M3.1's levels only when its settings entry declares them (all five, a subset, none for `false` or a missing field, none without a file), the Harness map passes through, `configureSession` sends `xhigh`, clears Default to `""` on M3.1 and sends nothing for Default on DeepSeek and M2.7, and two native turns through the fake ACP CLI switch to M3.1 and set `xhigh` before prompting, and finish a Default turn even when the CLI refuses `""`.
- `src/lib/model-effort.test.ts`: the DSH M3.1 picker shows only when its row carries levels.
- Offline payload check against the installed dsh and pi-ai with a blocked `fetch`: Default sends no thinking field, and Low, X-High and Max send `thinking: {type: "adaptive", display: "summarized"}` with `output_config.effort` set to the level.  Zero network calls.

## Still To Do

One paid MiniMax call (owner-approved) to confirm MiniMax accepts pi-ai's `thinking.display: "summarized"` with an effort, on the live harness after this lands.

## Merge Order

PR #762 and PR #764 also move the Clutch pin, and PR #742 edits `package.json`.  Whichever lands second regenerates `pnpm-lock.yaml` with `pnpm install` rather than merge-resolving it.  The DSH test updates here are the same text as #762's, and the `isDshEngineCli` rename is the same as #764's, so those hunks merge cleanly.  PR #764 renames the dependency key to `clutch`; after it lands, `harness/dsh/acp` imports here become `clutch/dsh/acp`.
