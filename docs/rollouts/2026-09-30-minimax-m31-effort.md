# 2026-09-30 — MiniMax M3.1 Reasoning Effort

Board row `873f0bbe`, branch `claude/minimax-m31-options`.  The owner asked for the model menu MiniMax Code now shows for M3.1 (a context window of 512K or 1M, and an effort of default, low, medium, high, xhigh or max), on the MiniMax Code engine and the other MiniMax engines where the underlying CLI or API supports it.  M3 has only a thinking switch, which BotFleet would always leave on.

## What Ships

Reasoning effort for M3.1 on two engines: **MiniMax Code** (`mcode acp`) and the **direct MiniMax HTTP engine**.  The levels are Default, Low, Medium, High, X-High and Max.  No UI code changes: Settings → Reasoning on the web and the effort picker on iOS already render "Default" plus whatever levels the selected model declares.

What does not ship, and why, is in the sections below: no context-window control on any engine, nothing for Harness (DSH), and M3 stays retired.

## Engine Matrix

| Model | MiniMax Code (`mcode acp`) | Direct HTTP (`/v1/chat/completions`) | Harness (DSH) |
|---|---|---|---|
| **M3.1 Flash Preview** | Effort: Default, Low, Medium, High, X-High, Max.  Wire: `session/set_config_option` with `configId: "thinkingEffort"`, sent after the model switch. | Effort: Default, Low, Medium, High, X-High, Max.  Wire: top-level `reasoning_effort`, on every round of the turn. | Not offered: installed dsh does not declare M3.1. |
| **M3** | Retired in #729.  If re-added: the `MiniMax-M3-thinking` row only (ACP value `m:minimax:MiniMax-M3:v:thinking`, thinking on), `effortLevels: []`. | Retired.  If re-added: send `thinking: {type: "adaptive"}` on every request, no effort control. | Excluded.  If re-added it must be forced to `high`, see below. |
| **M2.7 Highspeed** | `effortLevels: []`.  No call is sent, because mcode advertises no `thinkingEffort` for it. | `effortLevels: []`.  MiniMax documents `reasoning_effort` as M3.1-only. | `effortLevels: []` (existing DSH MiniMax rule). |

### MiniMax Code Wire

- `session/new` advertises the config options `permissionMode`, `model` and `thinkingEffort` (category `thought_level`).  `thinkingEffort` is present only when the selected model has effort options.  For M3.1 they are exactly `default, low, medium, high, xhigh, max`.  M3 and M2.7 have none.
- Setting an unadvertised value answers JSON-RPC -32602 "Thinking effort is not advertised for the selected model".
- A model switch resets the effort to `default`.  ACP core already runs the model switch before `configureSession`, so the driver sends the effort after it.
- The change is session-scoped and never writes `config.yaml`.
- The driver sends the picked level, or mcode's own literal `default` when none is picked.  `default` goes out **every turn**, so a level picked earlier in a reused or resumed session never sticks, and the owner's MiniMax Code TUI default never leaks into a bot that chose Default.
- The driver first reads the session's own option list, which core hands it after the model switch (the switch reply's `configOptions`, or `session/new`'s when no switch ran).  A list that is known, non-empty and has no `thinkingEffort` belongs to a CLI that cannot set one for this model, for example an older mcode or a login whose catalog has no effort options.  The turn then runs at the CLI's own level with a logged warning, for Default and for an explicit pick alike.  There is no level for it to be stuck at, and failing it would break every unattended, webhook and resource run, because the server stamps Low on those (see "Behaviour Change" below).  The cost: an explicit pick on such a CLI is ignored, visible only in the log, until MiniMax Code is updated.  A bare `{}` acknowledgement after a switch leaves the earlier list stale, so core withholds it and the capability is treated as unknown.
- When the session does advertise `thinkingEffort`, anything that goes wrong setting it fails the turn with "MiniMax Code did not accept thinking effort `<x>` for `<model>`".  That is a rejected value (-32602), a timeout, any other error, or a reply that reports a different current value.  It holds for Default too: a reply that still reports an earlier level (a resumed session that kept `high`), or a reset that errored, leaves the session at that level, and running anyway would bill the turn there.
- The one tolerated failure is a refused `default` (-32602) while the option list is unknown.  There it means "no such option", so there is no level to be stuck at, and the driver logs a warning and continues.  An explicit pick, a timeout, or any other error code still fails the turn.
- `none` (and any level the model lacks) is treated as Default with a warning.  M3.1 has no off switch.  This is the driver's defence for a turn that reaches it with such a value.  The normal product path never gets that far: `startTurn` first checks a stored effort against the model's own list and answers 409 ("effort `none` is not offered by model ...  choose another level in settings") with a fail-over to the next engine, as it does for every engine that does not offer `none` (Claude, Codex and Grok among them).  Settings and the PATCH routes already reject such a write (400), so a stored `none` on M3.1 can only be legacy data written while the engine was offline, and picking Default or any listed level in Settings clears it.  `startTurn` is deliberately not changed to turn `none` into Default for every engine, because on an engine where it means "reasoning off" that would silently start billing default thinking.

### Direct HTTP Wire

- The field is a top-level `reasoning_effort` (low, medium, high, xhigh or max), effective for `MiniMax-M3.1-Flash-Preview` only.  Docs: `platform.minimax.io/docs/api-reference/text-openai-api`.
- Omitting it means max.  Default therefore omits the field.
- `reasoning_effort: "none"` and `thinking: {type: "disabled"}` both return HTTP 400 on M3.1, so neither is ever sent, and the driver never writes a `thinking` field.
- Titles and summaries (the M2.7 Highspeed utility call) never carry the field.
- A model discovered from `GET /models` that the static table has never heard of gets `effortLevels: []`, because MiniMax documents the field as M3.1-only.
- Existing caveat, unchanged: MiniMax documents M3.1 as available only through Token Plan and MiniMax Code for now, so this row needs a Token Plan key.

### What "Default" Does On MiniMax Code

Read-only inspection of the installed 0.5.5 bundle (`chunks/run-acp-command-*.js`, `chunk-S2IS2DS4.js`, `chunk-CF3YFDG4.js`, `chunk-ALZ67EMN.js`), no prompt sent and no request made:

- `default` is the **first entry of M3.1's advertised effort options**, which come from MiniMax's own model catalog, not from code in the bundle.  The bundle carries no M3.1 metadata.
- Setting it goes to `selectSessionModel({..., thinking: {effort: "default"}})`.  On the managed login path (the one `mcode login` uses) the effort is validated against those advertised options and forwarded **verbatim** as `thinking_effort: "default"` on the provider request.
- mcode therefore resolves `default` to **no concrete level** on the client.  It never maps it to `high` or to the middle of the list.  (The middle-of-list fallback in the bundle applies only when no effort is selected and the model declares no default, on the bring-your-own-key path.)
- What MiniMax's server does with `default` is not observable without a paid request, which this lane did not make.  It is the same name MiniMax's own TUI preselects, and MiniMax's HTTP docs say an omitted `reasoning_effort` means max.  **Worth one owner check in the MiniMax Code TUI** if Default ever seems lighter than expected.

## Why There Is No Context-Window Control

The 512K or 1M window cannot be turned by any engine:

- **mcode.**  Its ACP layer handles only `permissionMode`, `model` and `thinkingEffort`.  The window is a TUI setting (`config.yaml` `defaultModelContextWindow`, "Higher usage" for 1M) that a fresh session inherits.  It is 1M on this Mac today.  A model switch drops it to 512K.  There is an open upstream request for an ACP option: `minimax-ai/minimax-code` issue #384, "CLI - ACP: expose the session context-window selection (parity with the /model picker)".  BotFleet will not write the owner's `config.yaml`.  Practical effect: BotFleet's M3.1 turns over mcode follow the MiniMax Code `/model` setting.
- **HTTP.**  The API has no selector.  The window is a fixed 1M, and input above 512K tokens bills at 2x, which the price table already models.  BotFleet's replay cap (200 KiB and 60 entries) keeps replayed history far below 512K.
- **Harness (DSH).**  The only lever is the static `contextWindow` in `settings.yaml`, which sets the compaction threshold, so it cannot be chosen per bot.

A picker for a window no driver can set would be a knob that does nothing, which `server/contracts.ts` (the `effortLevels` comment) already rules out for effort.

### Decided Future Shape (Not Built)

When an engine honours a window, add it as data, not as model-id variants:

- `contextWindow?: number` (tokens) on `ModelSelection`, beside `effort`.
- Per-model `contextWindowOptions: [{tokens: 512000, default: true}, {tokens: 1000000, badge: "Higher usage"}]` on catalog rows.
- Validate it in `checkedModelSelection`.  Carry it with effort through fallbacks and tasks.  Have fallback fitting drop it when the target lacks the option.
- On iOS, an optional `Int` with a server-side carry-forward so older apps do not wipe it.

Model-id variants were rejected: they double the picker rows, fork pricing, usage and lineage identity, and break saved-selection and fallback matching.

## Harness (DSH): What Unlocks M3.1

Nothing ships here.  `src/lib/model-effort.ts` rule 1 keeps effort hidden for DSH MiniMax rows, and the installed dsh 0.1.5-rc.2 (pi-ai 0.85.1) and `~/.dsh/settings.yaml` do not declare M3.1, so the DSH M3.1 row fails with `DshModelNotOfferedError` before effort matters.  Unlocking it takes three things:

1. An owner-machine `~/.dsh/settings.yaml` entry under `llm-pi-ai.providers.minimax.models` for `MiniMax-M3.1-Flash-Preview`, with `reasoningEfforts: {low: low, medium: medium, high: high, xhigh: xhigh, max: max}` and `compat: {forceAdaptiveThinking: true}`.  pi-ai then sends `thinking: {type: adaptive}` plus `output_config: {effort}` to `api.minimax.io/anthropic`.
2. A Harness PR that adds `xhigh` to Harness `EffortLevel`, publishes `perModelEffortLevels {"MiniMax-M3.1-Flash-Preview": [low, medium, high, xhigh, max]}`, and has Default send `""` (dsh's provider-default value) so a sticky level clears.  It is followed by a BotFleet dependency bump and removal of the `dsh.ts` `configureSession` early return.  Harness shape is edited in Harness, never in `server/drivers/acp/dsh.ts`.
3. One paid call to confirm MiniMax accepts pi-ai's `thinking.display: "summarized"`.

If M3 were ever re-added to DSH it must be forced to `high`: sending no effort makes pi-ai send `thinking: disabled`, which turns M3 thinking off.  This PR does not rename Harness to Clutch.

## M3 Stays Retired

M3 is out of every picker since #729.  "No effort picker, thinking always on" is met by not offering it.  To re-add it, use the rows described in the matrix above.

## Behaviour Change: Unattended Runs Start At Low

`unattendedModelDowngrade` (`server/model-fallback.ts`) stamps effort Low on unattended, webhook and resource-triggered runs whenever the selected model offers Low.  M3.1 now offers it on MiniMax Code and the direct engine, so those automated runs start at **Low** instead of MiniMax's default of max, like every other effort engine.  Attended turns are unaffected, and so is any run whose caller supplies its own model selection (`opts.modelSelection`).

The stamp **replaces a bot's own saved effort**: a bot set to Max in Settings still runs unattended, webhook and resource turns at Low.  This is how `unattendedModelDowngrade` already behaves on every effort engine, so it is not new, but M3.1 on mcode and the direct engine now joins it, and M3.1 is the default model on both.  There is no per-bot opt-out today, so the advice to "name the selection explicitly" is not available from Settings.  If that matters, the fix is a bot-level setting that exempts a bot from the unattended downgrade, which is a separate change.

## Overlap With PR #742

PR #742 (`ag/minimax-engine-updates`) also edits `STATIC_MCODE_MODELS`.  It adds bare `MiniMax-M3.1-Flash-Preview` and `MiniMax-M2.7-highspeed` rows.  Both contradict evidence from mcode 0.5.5: a bare M3.1 fails on a real turn (see the `readMcodeModelCatalog` comment and PR #686), and mcode advertises M2.7 Highspeed only as `v:thinking`.  This change gives any row that declares no levels an explicit `[]` (`withMcodeEffortLevels`), so it stays correct whichever lands first.  If #742 merges first, rebase onto it and give its bare rows `effortLevels: []`.

## Verification

All tests use the fake ACP CLI and a stubbed `fetch`.  No live MiniMax request was made, no mcode turn was run with a prompt, and nothing read `~/.minimax/config.yaml` values or `~/.botfleet`.

- `server/drivers/acp/mcode.test.ts`: M3.1 sends the picked level after the model switch, Default sends `default` every turn, M2.7 sends no call, a session that keeps another level fails the turn, an unadvertised level fails with the level named, `none` degrades to Default, a session that reports it kept an earlier level fails a Default turn too, a reset that errors with anything but a refusal fails a Default turn, a session that advertises no `thinkingEffort` (older mcode) runs at the CLI's own level for Default and for a pick, and a refused `default` only logs when the option list is unknown.
- `server/drivers/minimax.test.ts`: `reasoning_effort` on every round including a tool round, absent for Default, `none`, M2.7 and the utility call, `refreshModels` keeps M3.1's levels and gives an unknown id none.
- `src/lib/model-effort.test.ts` and `server/model-fallback.test.ts`: picker levels for both engines, DSH MiniMax rule unchanged, unattended runs stamp Low.
- The fake ACP CLI gained `FAKE_ACP_REASONING_CONFIG_ID`, `FAKE_ACP_REASONING_MODELS` and `FAKE_ACP_REASONING_ERROR_CODE`, backward compatible (documented in its header).
- `server/drivers/acp/core.ts` gained an optional `sessionConfigOptions` field on the `configureSession` context, passed only when a current option list is known.  Other ACP drivers ignore it.

## Owner Questions

1. **Context window.**  Is MiniMax Code's own `/model` window (1M today) acceptable for BotFleet turns until the upstream ACP option (issue #384) lands?
2. **Harness M3.1.**  Do you want the Harness unlock above (a `settings.yaml` edit on this Mac, a Harness PR, and one paid verification call)?
3. **M3.**  Should it stay retired, or come back as a thinking-on-only row?
4. **Chat model menu.**  Should effort also appear in the chat model menu, as it does in MiniMax Code, rather than only in Settings → Reasoning?
