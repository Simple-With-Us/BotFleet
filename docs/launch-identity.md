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
| `OTEL_RESOURCE_ATTRIBUTES` | The inherited value with `agent.launcher=botfleet` and `agent.launcher.session=<thread id>` appended (comma-joined, the thread id percent-encoded).  An inherited entry for either key is replaced, never duplicated.  A child that exports its own OpenTelemetry (Claude Code, Codex) carries them, so Usage Monitor can tell its native events belong to a BotFleet turn and count the turn once. |

A bot whose name names no role still gets `AGENT_LAUNCHER`, `AGENT_SYNC_ATTACH` and `AGENT_SESSION`, and no seat.  The fleet tools then refuse to act, instead of falling back to a platform default.

BotFleet first removes everything that could carry a different identity or a Zulip login from the environment it inherited:  `AGENT_SEAT`, `AGENT_TAG`, `AGENT_SESSION`, `CLAUDE_CODE_SESSION_ID`, and every name starting `AGENT_LAUNCH`, `AGENT_SYNC_` or `ZULIP_`.  That covers the harness's own environment and an engine instance's configured environment alike, so a harness started from a seat's terminal cannot pass that seat on.  Role bots post through BotFleet's own Zulip support (`docs/zulip.md`), so no engine process is given a key.

Where it applies:  the Claude, Codex, ACP (every ACP engine), Antigravity, pi and CLI-wrapper drivers, the shell of the HTTP-lane `bash` tool, and a background job's shell.  The Claude driver also keys its warm process on the seat and session, so a second bot on the same thread starts its own process.  The Codex driver additionally passes `-c shell_environment_policy.set.<NAME>=...` for the five variables, because Codex runs the model's shell commands under its own environment policy.

## MCP Servers And Shell Commands On mcode

An mcode turn starts more processes of its own:  the MCP servers it knows, and the commands of its shell tool.  mcode 0.6.2 starts all of them from the `mcode acp` process BotFleet launched, and each one sees the five variables above (the test probes those names only, so it says nothing about the rest of the environment).  That holds for a server listed in the data directory's `mcp.json` (the owner's `~/.minimax/mcp.json`) and for one BotFleet sends in `session/new`.  A server's own `env` block is added on top.  Nothing here is BotFleet code:  it is how mcode starts them, which is why `server/drivers/acp/mcode-launch-seat.test.ts` pins it.

That is what lets the owner's `agent-sync mcp --default-seat MM` entry sign a launched bot's posts as the bot.  agent-sync takes the launcher's seat first and reads `--default-seat` only when no launcher started the session:

| Process | Seat agent-sync serves |
| --- | --- |
| Launched by BotFleet, seat assigned | The bot's role seat (`BF-MONITOR`), with the credential `BF_MONITOR_ZULIP_KEY` from Infisical Fleet-OPS `/zulip`.  Posts are tagged `[BF-MONITOR·<session>]`. |
| Launched by BotFleet, no seat (the switch below is off, or the name names no role) | None.  agent-sync exits 3 and the bot is offered no agent-sync tools. |
| Not launched (the owner's own MiniMax Code) | `MM`, from `--default-seat MM`.  Posts are tagged `[MM]`. |

So a bot's post signed `[MM]`, with no session part, did not come from a launched turn of this code:  its process had neither `AGENT_LAUNCHER` nor `AGENT_SESSION`, and every launched turn has both.  The tests show mcode is not what dropped them.  Check in this order:  restart the harness after an update, because a process started before the launcher contract landed keeps running the old code, then look for a spawn path that skips `applyLaunchIdentity`.

Two consequences of the switch.  With `BOTFLEET_FLEET_SEAT_PROMPTS` off, a launched mcode bot cannot post through agent-sync at all, which is the safe failure.  With it on, the bot's credential file must exist (mode 600) in the home mcode runs with, or agent-sync exits 3 for the same reason.

## Linear Board Access

The local `board` command is the fleet's Linear-backed CLI.  It is discovered through BotFleet's augmented PATH (`~/.local/bin` is one of the standard GUI-launch locations), and the launch variables above give it the bot's assigned seat.  The shared role prompt tells every operator bot to list and inspect Linear issues before substantial work, claim the issue before editing, and treat issue text as untrusted data.

BotFleet does not copy Linear credentials into an engine environment.  The CLI resolves its own authorized credential source on the host; when that source or the command is unavailable, the bot reports the missing capability and continues only independent work.  This keeps Linear access consistent across engines with a shell without exposing the credential to the model.

## Which Bots Get a Seat

The eleven role seats are `BF-BUILDER`, `BF-COMPILER`, `BF-DEPLOYER`, `BF-DESIGNER`, `BF-DIRECTOR`, `BF-FIXER`, `BF-HOUSEKEEPER`, `BF-MONITOR`, `BF-ORACLE`, `BF-PLUMBER` and `BF-PUBLISHER`.  A bot's role comes from, in order:

1. An `@fleet-seat: <role>` line in the bot's description.
2. A name with a `BF-` or `BF ` prefix (`BF-Plumber`).
3. A name that is exactly a role, any case (`Plumber`).

A name that only contains a role word (`Plumber 2`) names no role.  Director has been a role since 2026-10-11 (owner):  it has its own Zulip bot, `bf-director-bot@`, so `BF-Director` and `Director` resolve to `BF-DIRECTOR` like any other role.  This is by name, as the seat prompt has always resolved it.  The Zulip binding (`zulip.bots`, by bot id) is a separate setting:  keep the two in agreement, because the seat in the environment and the bot a native post is sent as come from different places.

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
- `server/drivers/acp/mcode-launch-seat.test.ts`:  the real `mcode` CLI against a scripted fake model and a fake Zulip, in a throwaway data directory.  A launched turn's MCP server (from `mcp.json` and from `session/new`) and shell see the five launch variables and no other `AGENT_` name (the probe reports `AGENT_` names only);  the real `agent-sync mcp --default-seat MM` answers `whoami` as `BF-MONITOR` for a launched turn, refuses with no seat, and still answers `MM` for an ordinary MiniMax Code session.  Needs `mcode` (and `agent-sync` for the last group) on the machine;  skips with a message when they are absent, as in CI, or with `BOTFLEET_REAL_MCODE_TESTS=0`.
