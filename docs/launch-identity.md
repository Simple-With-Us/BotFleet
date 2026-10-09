# Launch Identity

BotFleet starts an engine process (claude, codex, an ACP engine, agy, pi, a wrapped CLI) for every bot turn.  Those engines read their own platform's rules files, skills and hooks, and those files name a default seat.  Without a signal from the launcher, a plumber bot on the claude engine would act as the Claude seat and a plumber bot on the codex engine as the Codex seat.  This page is what BotFleet tells each engine process, so the fleet's tools and the bot agree on who it is.

The code is `server/launch-identity.ts`.  The contract with the fleet tools (the `agent-sync` CLI and its hooks) is AI-Fleet-Coordinator `docs/protocols/zulip-fleet-guide.md`, Launcher Contract.

## What Every Engine Process Gets

Set per bot and per turn, in the environment of the process that runs the turn.  Not per engine instance:  two bots on one claude instance get two seats.

| Variable | Value |
| --- | --- |
| `AGENT_LAUNCHER` | `botfleet`.  A launcher started this session, so no platform default applies. |
| `AGENT_LAUNCH_SEAT` | The role seat BotFleet assigned.  Only the launcher writes it. |
| `AGENT_SEAT` | The same value, for older readers. |
| `AGENT_SESSION` | BotFleet's id for the thread the turn runs on (a room turn uses the room's thread). |
| `AGENT_SYNC_ATTACH` | `0`.  The Claude hooks plugin never attaches a session BotFleet launched. |

A bot whose name names no role still gets `AGENT_LAUNCHER`, `AGENT_SYNC_ATTACH` and `AGENT_SESSION`, and no seat.  The fleet tools then refuse to act, instead of falling back to a platform default.

BotFleet first removes everything that could carry a different identity or a Zulip login from the environment it inherited:  `AGENT_SEAT`, `AGENT_TAG`, `AGENT_SESSION`, `CLAUDE_CODE_SESSION_ID`, and every name starting `AGENT_LAUNCH`, `AGENT_SYNC_` or `ZULIP_`.  That covers the harness's own environment and an engine instance's configured environment alike, so a harness started from a seat's terminal cannot pass that seat on.  Role bots post through BotFleet's own Zulip support (`docs/zulip.md`), so no engine process is given a key.

Where it applies:  the Claude, Codex, ACP (every ACP engine), Antigravity, pi and CLI-wrapper drivers, the shell of the HTTP-lane `bash` tool, and a background job's shell.  The Claude driver also keys its warm process on the seat and session, so a second bot on the same thread starts its own process.  The Codex driver additionally passes `-c shell_environment_policy.set.<NAME>=...` for the five variables, because Codex runs the model's shell commands under its own environment policy.

## Which Bots Get a Seat

The ten role seats are `BF-BUILDER`, `BF-COMPILER`, `BF-DEPLOYER`, `BF-DESIGNER`, `BF-FIXER`, `BF-HOUSEKEEPER`, `BF-MONITOR`, `BF-ORACLE`, `BF-PLUMBER` and `BF-PUBLISHER`.  A bot's role comes from, in order:

1. An `@fleet-seat: <role>` line in the bot's description.
2. A name with a `BF-` or `BF ` prefix (`BF-Plumber`).
3. A name that is exactly a role, any case (`Plumber`).

A name that only contains a role word (`Plumber 2`), and `BF-Director`, name no role.  This is by name, as the seat prompt has always resolved it.  The Zulip binding (`zulip.bots`, by bot id) is a separate setting:  keep the two in agreement, because the seat in the environment and the bot a native post is sent as come from different places.

## The Switch

Seats and the seat sentence in the system prompt are on together, with `BOTFLEET_FLEET_SEAT_PROMPTS=1` in the harness's environment (the Mac operator fleet).  Off, every engine process is still marked as launched and cleaned of inherited identity, and has no seat, so the fleet tools refuse.  An install that has not turned the operator fleet on carries no seat names at all.

The seat sentence is `bots/_seat.md`.  It says the bot's seat, that BotFleet assigned it, that the assignment overrides any default seat in the engine's own rules files, skills or memory, and that a missing or different `AGENT_LAUNCH_SEAT` means no seat.  The role's own lines are `bots/<role>.md`.

## Codex Environment Policy

A user's Codex config can narrow the environment of the model's shell commands with `shell_environment_policy.include_only`.  Depending on the Codex build, the `-c ...set...` overrides above may not survive that filter.  If `include_only` is set in the Codex config BotFleet's Codex engine uses, add `AGENT_SEAT`, `AGENT_LAUNCH_SEAT`, `AGENT_LAUNCHER`, `AGENT_SESSION` and `AGENT_SYNC_ATTACH` to it.  Whether `set` survives `include_only` has not been checked against a live Codex.

## Tests

- `server/launch-identity.test.ts`:  roles, resolution, the environment, the scrub, the Codex overrides.
- `server/drivers/*.test.ts` (claude, codex, acp, antigravity, pi, cli-wrapper):  the real fake engine process sees each bot's own seat, none of the inherited identity, and no Zulip variable.
- `server/launch-identity-wiring.test.ts`:  the real harness, a 1:1 chat and a room turn, from an environment that holds a seat and a Zulip login.
- `server/tools/computer.test.ts`, `server/tools/host.test.ts`, `server/jobs/registry.test.ts`:  the `bash` tool and job shells.
