# 2026-10-01 — MiniMax M3.1 Reasoning Effort On Harness (DSH)

Board row `873f0bbe`, branch `claude/dsh-m31-effort`.  Owner approval 2026-10-01: enable MiniMax M3.1 on the Harness (DSH) engine with the `settings.yaml` entry, a Harness change for effort levels plus this BotFleet bump, and one paid MiniMax call to confirm it works.  This follows PR #756 (MiniMax Code and the direct HTTP engine), whose rollout doc `2026-09-30-minimax-m31-effort.md` lives in that PR until it merges and whose "Harness (DSH): What Unlocks M3.1" section listed these three steps.

## What Ships

- **Harness (Clutch) #65**, merged as `2d57ec5`: `EffortLevel` gains `xhigh`, `dshSupport.perModelEffortLevels` publishes `MiniMax-M3.1-Flash-Preview: [low, medium, high, xhigh, max]`, `dshInstalledEffortLevels(settings)` narrows that to what an install's `settings.yaml` declares, and Default on a row with per-model levels sends dsh's provider-default value `""`.  Harness doc: `docs/dsh-reasoning-effort.md` in that repo.
- **Harness (Clutch) #66**, merged as `7fbd88d`, the corrective the #769 review asked for: `dshInstalledEffortLevels` also requires `compat.forceAdaptiveThinking: true` on the entry, the Default `""` request swallows only dsh's invalid-params refusal (`-32602`) so a timeout or internal error still surfaces, and the effort-mismatch error says "Engine" instead of "DeepSeek Harness".
- **BotFleet** moves the `clutch` pin from `6edb253` (#764) to `github:jaywedgeworth22/Clutch#7fbd88d…`, which brings Clutch #63, #65 and #66, and:
  - `readDshModelCatalog` sets the M3.1 row's `effortLevels` from the installed settings, so the picker offers Default, Low, Medium, High, X-High and Max only when dsh will take them and pi-ai will send them as distinct adaptive levels, and an explicit `[]` otherwise.
  - `readDshSettingsPath` treats `$DSH_HOME` as dsh's engine home itself, the way dsh and `dshCredentialCandidates` do, so it reads `$DSH_HOME/settings.yaml`.  It used to look in `$DSH_HOME/.dsh/settings.yaml`, one folder too deep, which hid M3.1's levels whenever `DSH_HOME` was set.  The default, `~/.dsh/settings.yaml`, is unchanged.
  - The DSH `configureSession` delegates to Clutch instead of keeping its own copy.  The old copy returned early whenever a turn had no effort, which left a level an earlier turn pinned on a resumed session in force.

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

A machine whose entry lacks `reasoningEfforts`, has `reasoningEfforts: false`, lacks `compat.forceAdaptiveThinking: true` (missing, `false`, or any non-boolean), or has no M3.1 entry at all gets no M3.1 picker: `dshInstalledEffortLevels` answers `[]` there, and that explicit `[]` wins over the static per-model map.  The flag matters because without it pi-ai switches to fixed thinking budgets, clamps `xhigh` and `max` to `high`, and sends no `output_config.effort`, so three of the five levels would send the identical request.

## What Default Does

A turn with no effort on M3.1 sends `reasoning_effort: ""`, dsh's "Provider default", which clears a level an earlier turn left on a resumed session.  pi-ai then sends no thinking field and MiniMax applies its own default.  The request is best effort for one failure only: a route that declares its own default effort refuses `""` with invalid params (`-32602`), and the turn then runs at the session's current level instead of failing.  A timeout or an internal error still fails the turn.  DeepSeek rows still send nothing for Default, because their routes always declare a default effort and dsh refuses `""` for them.

## Behaviour Changes

- **Unattended runs start at Low.**  `unattendedModelDowngrade` stamps Low on unattended, webhook and resource-triggered runs whenever the selected model offers Low.  DSH M3.1 now offers it, so those runs start at Low instead of MiniMax's default, the same as M3.1 on MiniMax Code and the direct engine (see PR #756's rollout doc).
- **Clutch #63 rides along.**  A DeepSeek picker id with no advertised catalog now encodes to dsh's stock wire id (`DeepSeek-V4.1-Flash` → `deepseek-flash`), so a turn that names no model reports `deepseek-flash` as its session model.  Those test updates are the same text as PR #762's.

## Verification

All tests use temporary homes and the fake ACP CLI.  No test reads `~/.botfleet` or contacts the harness on port 8799.

- Clutch #65: `npm run typecheck` clean, `npm test` 16 files and 150 tests, and CI green (verify, e2e, iOS Build, gitleaks).
- Clutch #66: `pnpm typecheck` clean, `pnpm test` 16 files and 153 tests.  The adaptive-flag fixtures, the non-refusal Default failures and the exact mismatch wording fail against the #65 driver and pass on #66.
- `server/drivers/acp/dsh.test.ts`: the live catalog offers M3.1's levels only when its settings entry declares them (all five, a subset, none for `false` or a missing field, none for a missing or `false` adaptive flag, none without a file), reads `$DSH_HOME/settings.yaml` when `DSH_HOME` is set, the Harness map passes through, `configureSession` sends `xhigh`, clears Default to `""` on M3.1 and sends nothing for Default on DeepSeek and M2.7, swallows only the `-32602` refusal of that `""`, and two native turns through the fake ACP CLI switch to M3.1 and set `xhigh` before prompting, and finish a Default turn even when the CLI refuses `""` (the RPC dump proves the `""` was sent before the prompt, which the fake's config dump cannot).  The effort-mismatch test now pins the engine-neutral wording.
- `src/lib/model-effort.test.ts`: the DSH M3.1 picker shows only when its row carries levels.
- Offline payload check against the installed dsh and pi-ai with a blocked `fetch`: Default sends no thinking field, and Low, X-High and Max send `thinking: {type: "adaptive", display: "summarized"}` with `output_config.effort` set to the level.  Zero network calls.

## Still To Do

One paid MiniMax call (owner-approved) to confirm MiniMax accepts pi-ai's `thinking.display: "summarized"` with an effort, on the live harness after this lands.

## Merge Order

PR #764 (the `clutch` key) has landed and is merged into this branch.  PR #762 also moves the Clutch pin and PR #742 edits `package.json`.  Whichever lands second regenerates `pnpm-lock.yaml` with `pnpm install` rather than merge-resolving it.  The DSH wire-id test updates here are the same text as #762's, so those hunks merge cleanly.
