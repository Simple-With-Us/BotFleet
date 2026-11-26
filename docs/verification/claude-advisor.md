# Claude Advisor Verification

The advisor is a launch flag on the Claude engine, so it is verified against the fake CLI that stands in for the real one, and against the real CLI's own help text.

## The flag reaches the turn

`server/drivers/claude.test.ts` drives the fake CLI (`server/testing/fake-claude-cli.ts`) and reads the argv the turn was launched with.

| Case | What it proves |
| --- | --- |
| `launches the turn with the advisor model the turn asked for` | a turn with an advisor launches with `--advisor <model>` |
| `leaves the advisor off a turn that asked for none` | a turn without one has no `--advisor` in its argv |
| `refuses the turn when the CLI does not announce the advisor flag` | a CLI whose help does not announce `--advisor` is refused before the turn starts, not after |

The fake answers `--help` with the flags the real CLI announces, and `FAKE_CLAUDE_ADVISOR=off` takes the flag back out, which is how the refusal case is produced.

## The selection keeps it

`server/index.test.ts` covers the API:  a bot's model selection keeps `advisorModel`, and a value that is not a model id is refused with a 400, because an advisor reaches the engine as one launch argument.

## The real CLI

The real CLI's own help is the authority on whether a CLI can run an advisor turn:

    claude --help | grep -- --advisor

A CLI that predates the flag answers with an unknown option, so the driver refuses the turn before it starts rather than letting the launch fail.

## What a fixture cannot prove

A live advisor turn, where the CLI calls a second model at a key moment, needs a signed-in Claude seat.  The fleet injects seat credentials per seat, so that part is verified on a real bot rather than in a fixture.
