# The Claude Advisor Model Rides The Turn

Refs BF-2704.

The Claude Code CLI can consult a second model as an advisor while it answers.  The way to turn that on from a chat, the `/advisor` command, is denied twice in the driver, because a bare `/advisor opus` that reached the CLI rewrote `advisorModel` in the owner's global `~/.claude/settings.json` (server/drivers/engine-commands.ts:5-6, :48, :105).

The flag form has no such problem:  `--advisor <model>` is per launch, so it applies to one turn and writes nothing.

## What changed

- `ModelSelection.advisorModel` and `SendTurnInput.advisorModel` (server/contracts.ts) carry the advisor, and `isAdvisorModel` is the one rule for what a model id is.
- The shared Claude driver launches the turn with `--advisor <model>` (server/drivers/claude.ts).
- The driver probes `claude --help` for `--advisor`, cached the way the `--strict-mcp-config` probe is, and refuses the turn with a clear reason when the CLI does not announce the flag, instead of letting the turn die on an unknown option.
- The bot's model selection accepts and persists `advisorModel` (server/index.ts), so an advisor is set per bot or per thread and rides every turn.

## What it does not do

- It never writes a settings file, so the owner's global Claude settings stay untouched.
- It does not choose the advisor for you:  the CLI refuses a model that does not support the advisor tool, and that refusal is the CLI's.
- The desktop and iOS pickers do not carry an advisor yet;  the API does (`PATCH /api/bots/:id` with `modelSelection.advisorModel`).

## Evidence

- The server's own Claude seat CLI is 2.1.330 and the Mac's is 2.1.331.  Both carry `--advisor <model>` and the `advisorModel` settings key.
- A live CLI run against a throwaway config accepted both `--advisor <model>` and `--settings '{"advisorModel":"..."}'` with no unknown-option or validation error, and wrote no settings file.
- The turn-side tests are in `server/drivers/claude.test.ts` (the turn launches with the flag, a turn without one has no flag, and a CLI that does not announce the flag is refused) and the API test is in `server/index.test.ts` (the selection keeps the advisor, and a value that is not a model id is refused).

## Setting one

`PATCH /api/bots/:id` takes the whole selection, the way any other selection field is set:

    {"modelSelection": {"instanceId": "claude", "model": "claude-sonnet-5-5", "advisorModel": "claude-opus-5-5"}}

The advisor model has to be one the CLI accepts for the advisor tool, and the main model has to accept one.
