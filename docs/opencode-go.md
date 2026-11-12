# OpenCode

OpenCode is an optional BotFleet engine. BotFleet runs the maintained
OpenCode CLI through its ACP stdio interface, so sessions, streaming, coding
tools, permission requests, MCP integrations, resume, and cancellation use the
same runtime as the other ACP engines.

## Setup

1. Install the official CLI using the
   [OpenCode installation guide](https://opencode.ai/docs/).
2. Connect the providers you want in the OpenCode app, or run
   `opencode auth login`.
3. Restart BotFleet. It reuses OpenCode's existing connections and model
   configuration automatically.

OpenCode includes anonymous free models. A Zen, Go, OpenRouter, or other
provider connection expands the catalog according to the installed CLI. An
OpenCode API key can optionally be stored under Settings → Connections. It is
write-only and injected as `OPENCODE_API_KEY` only into the OpenCode child
process; it is not sent to the renderer, logs, analytics, snapshots, error
messages, or command arguments.

BotFleet does not copy or rewrite `auth.json`. The OpenCode CLI remains the
owner of provider authentication, and the same Zen or Go connection used by
the OpenCode desktop/TUI is used by BotFleet.

## Models

The model picker runs `opencode models --verbose` against the configured binary
and preserves every exact `provider/model` ID returned by the CLI. This can
include Zen (`opencode/*`), Go (`opencode-go/*`), third-party providers, custom
configuration, and local endpoints. If discovery temporarily fails, the last
successful catalog is used, followed by a small anonymous-model fallback.

Before every prompt, ACP receives `session/set_config_option` with
`configId: "model"` and the exact selected provider-qualified model ID.

## Sign-in check

Before a turn starts, BotFleet asks whether OpenCode can run it:  an
`OPENCODE_API_KEY`, a stored login in `auth.json`, or an `opencode models`
that lists at least one model.  If the CLI answers and none of those holds,
the turn is refused with "OpenCode has no usable models".

`opencode models` gets 20 seconds on an idle host, stretched up to 60 seconds
as the host's load average passes its core count (the same rule as the ACP
initialize deadline).  A probe that runs out of time or is killed has not
answered, so it is not read as signed out:  the turn goes to the CLI, which
answers for itself, and the engine is not marked "not signed in".  A list is
remembered for ten minutes, an empty answer for thirty seconds, and a timeout
not at all.

## Testing

Normal unit and ACP protocol tests do not require a subscription. Live tests
must be explicitly enabled and must never print credentials or upload native
protocol logs from a credentialed run.
