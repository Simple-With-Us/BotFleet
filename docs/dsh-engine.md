# DeepSeek Harness (`dsh`) engine

What the engine actually is, what it can and cannot do, and why.  Written
against `@deepseek-ai/dsh@0.1.1-rc.2` and its sibling packages, read on
2026-09-09.  If you are about to promise a capability in the UI, check it
against the tables here first.

## The headline: `dsh` has no ACP mode

The `dshAgent` driver is an ACP driver, and the ACP core spawns whatever
`config.cli` names and then speaks Agent Client Protocol to it over stdio.
Until this change, `defaultCli` was the bare word `dsh`.

`dsh` is not an ACP server.  Its CLI (`lib/bin.js`, a Commander program) takes
`--profile <name>`, `--patch <path>`, `--dump-config`, `--dump-default-config`,
`--version`, and two subcommands (`web`, `plugin`).  There is no `acp`
anywhere in it.  So the engine spawned a process that could not answer
`initialize`, and every turn died at the handshake.

The fix is `tools/dsh-acp/dsh-acp.py`: a fleet-authored, standard-library-only
Python bridge that speaks ACP on stdio and drives `dsh --profile headless`
underneath, one child process per turn.  `defaultCli` is now
`<python3> <bridge>` — a `cli` string carrying one fixed leading argument,
which `server/env-path.ts` already supports for wrapper scripts.  The Engines
panel's custom-binary field still overrides it, so a user can point at their
own ACP server (see *The native ACP path* below) or at a future `dsh acp`.

```
BotFleet  ──ACP/JSON-RPC over stdio──▶  tools/dsh-acp/dsh-acp.py
                                             │  one subprocess per prompt
                                             ▼
                                      dsh --profile headless "<prompt>"
```

## What the bridge needs

| Variable | Set by | Meaning |
|---|---|---|
| `DSH_BIN` | driver | The `dsh` executable.  Driver order: explicit `DSH_BIN`, then `dsh` on PATH, then `$DSH_RUNTIME_ROOT/node_modules/.bin/dsh`.  The bridge applies the same order itself when the host passes nothing. |
| `DSH_HOME` | driver | Harness home.  Defaults to `~/.dsh`.  Holds `.credentials.yaml`, `profiles/`, and `sessions/`. |
| `DSH_RUNTIME_ROOT` | driver, when present | Root of a local `dsh` install.  The vendored bridge has **no** default for this; the fleet Mac's `~/apps/dsh-runtime` is passed in when it exists. |
| `DSH_PERMISSION_MODE` | driver, every turn | Sandbox posture.  See below. |
| `DSH_ACP_TIMEOUT_SEC` | optional | Per-turn wall clock, default 900. |
| `DSH_ACP_HEARTBEAT_SEC` | optional | Thought-chunk heartbeat, default 5.  Headless `dsh` prints nothing until the final answer, so without this the client sits in Thinking with no signal. |

## Permissions — read this before trusting `DSH_PERMISSION_MODE`

The harness has two independent knobs, from `@deepseek-ai/dsh-sandbox` and
`@deepseek-ai/dsh-permission-presets`:

- **Sandbox mode**: `read-only` (its own fail-safe default), `workspace-write`,
  `danger-full-access`.
- **Approval policy**: `ask` or `never`.

The two shipped presets pair them: `workspace-write` + `ask`, and
`danger-full-access` + `never`.

`DSH_PERMISSION_MODE` is **not a package-level convention**.  Grepping every
installed `@deepseek-ai/dsh-*` package for that literal returns nothing.  It is
a *profile* convention: a profile's `cordis.yml` has to read
`process.env.DSH_PERMISSION_MODE` for it to mean anything.  The fleet's
hand-built `acp` profile does exactly that.  The stock `headless` profile —
the one this bridge drives — does not, so it falls back to the sandbox's own
`read-only`.

The driver sets the variable on every turn regardless, and that is deliberate:

1. It is correct for the profiles that do read it.
2. When it is ignored, the landing spot is `read-only`, which is the safe one.
3. It is **set, never merely defaulted**.  `DSH_PERMISSION_MODE` can already be
   exported in a user's shell — the fleet Mac exports `danger-full-access` for
   its own headless runner — and `...process.env` would otherwise carry that
   into a bot whose Full Auto switch is off.  The driver owns this value; the
   ambient environment does not get a vote.

Mapping: Full Auto on → `danger-full-access`.  Full Auto off →
`workspace-write`.

**Open consequence.**  With approval policy `ask`, the harness will want to
prompt, and the bridge detaches the child from stdin — so an approval request
has nobody to answer it and the turn stalls until `DSH_ACP_TIMEOUT_SEC`.
Mapping approvals onto ACP `session/request_permission` is the fix, and it is
the next PR's job.  Until then a DSH bot that needs to write files wants Full
Auto on.

## Sessions — every turn is fresh

There is no working resume on this package set, and the driver no longer
pretends otherwise.

- The `headless` profile's own parser (`dsh-headless/lib/startup.js`) accepts a
  task positional and `-h`, nothing else, and does **not** allow unknown
  options.  A stray `--resume` is a parse error that exits non-zero before the
  model is reached.  The bridge used to append one whenever a session id began
  with `session-`; that branch is removed.
- `dsh-headless`'s own README: "creates one fresh persisted Agent… One
  submitted task only — the runner has no interactive follow-up surface."
- `@deepseek-ai/dsh-acp`'s README, on the native ACP path: "Fresh sessions
  only — load, list, resume, delete, and fork are unsupported."
- The underlying primitive *could* do it: `SessionStore.create(id, …)` /
  `prepare(id, …)` in `@deepseek-ai/dsh-session` accepts a caller-supplied id
  and mints `session-<n>` only when the id is omitted.  But no shipped CLI or
  ACP entry point threads an external id into that parameter.  Real resume
  therefore needs a custom profile plugin, not a flag.

Practical effect: a DSH bot has no thread memory across turns beyond what
BotFleet itself replays into the prompt.

## Model selection — the picker cannot change the model

`dsh` has no `--model` flag.  Model is a *config* field on the LLM adapter row
in a profile's `cordis.yml` (`model: deepseek-v4-pro`, and so on).  The bridge
answers `session/set_model` with a bare `{}` — a silent success — and the
profile's own model runs regardless of what the picker shows.

`STATIC_DSH_MODELS` lists `deepseek-v4-flash` and `deepseek-v4-pro`, which is
what `@deepseek-ai/dsh-llm-deepseek` advertises (plus an image-capable
`deepseek-v4-flash-vision-exp`, deliberately omitted while `images: false`
gates the composer for the whole engine).  Those ids are honest about what the
harness *can* run.  They are not honest about what the picker can *select*.

`configureSession` in `server/drivers/acp/dsh.ts` already throws when
`set_model` fails, which today is dormant.  That is the right order: make the
bridge answer honestly first, and this catches the regression the moment it
does.  Fixing the selection itself means writing the model into the profile
config before the run, or composing a profile that reads it from the
environment — tracked for the bridge-protocol PR.

## MCP — not through the wire

`mcpServers: false` on the driver, and it stays that way.

The harness does support MCP, through `@deepseek-ai/dsh-mcp-client`, but as a
per-server plugin row in a profile's `cordis.yml`:

```yaml
- id: mcp-github
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio        # or streamable-http
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
```

Tools then register as `mcp__<serverName>__<rawName>`.  There is no top-level
MCP config file and no `--mcp` flag.  `@deepseek-ai/dsh-acp` goes further and
*rejects* a non-empty `session/new.mcpServers`.

So an ACP client cannot inject MCP servers per session; they have to be baked
into the profile server-side.  The driver's old `dshSpawnArgs` emitted
`--mcp name=command args` for every integration, and nothing anywhere parsed
them — every one was a tool the app offered and the engine could never call.
That argv is gone.

## Usage and tool events — nothing on the wire

`dsh-headless` writes only the final assistant text to stdout; its README lists
its Model Experience as "None".  The native ACP path is no better: "Live
progress, reasoning, tool activity, plans, titles, and usage stay off the
wire."  Token usage exists internally as `ctx.tokenMeter` and is consumed by
the harness's own UI projections — it is never printed.

So `session/prompt` reports no usage, and there are no `tool_call` /
`tool_call_update` updates to forward.  Cost for a DSH turn cannot be derived
from the engine today.

## Authentication — there is no `dsh login`

Grepping the CLI and its command packages for a login subcommand returns
nothing.  Auth is a credentials file or an inherited environment variable, in
this precedence (highest first), per `@deepseek-ai/dsh-credentials-local`:

1. Inherited process environment — `DEEPSEEK_API_KEY=… dsh`
2. `$DSH_HOME/.credentials.yaml` — `refs: { DEEPSEEK_API_KEY: … }`; the only
   writable layer, `0600` inside a `0700` directory
3. `<invocation cwd>/.env`
4. `$DSH_HOME/.env`

The driver therefore advertises `install.command`
(`npm install -g @deepseek-ai/dsh`) and **no** `signInCommand` — pointing a
user at a command that does not exist is worse than saying nothing.  The
`loginNote` names the two real options instead.

## The native ACP path, for later

There *is* a first-party ACP server: `@deepseek-ai/dsh-acp-demo` (bin
`dsh-acp-demo`), composed with `@deepseek-ai/dsh-acp`.  It is not reachable
from a plain `npm install -g @deepseek-ai/dsh`: it needs a profile built with
`dsh plugin --profile <name> add …` plus a hand-written `cordis.yml`.  The
fleet Mac has one at `~/.dsh/profiles/acp/cordis.yml`.

Its capability set is not better than the bridge's — fresh sessions only, no
per-session MCP, no usage or tool events on the wire — so switching to it buys
protocol purity, not features.  A user who has built such a profile can point
this engine straight at it today with the custom-binary field.

## Packaging

The bridge is edited at `tools/dsh-acp/dsh-acp.py` and copied to
`dist-server/dsh-acp.py` by `scripts/bundle-server.mjs`, exactly as
`drivers/pi-mcp-extension.ts` is.  It is resolved through
`SPAWNED_SCRIPTS.dshAcp` in `server/proxy-paths.ts` and nowhere else — a `".."`
written inside `drivers/` climbs from the *bundle's* directory once esbuild
inlines it, which is how every proxy path broke in 0.1.24.

Sibling copies of the bridge live in `ai-fleet-coordinator/scripts/` and
`~/apps/dsh-runtime/` for Shellular.  Those keep the Mac-specific
auto-approve posture and the hard-coded runtime root; the vendored copy here
has neither, because it ships inside a product.

## Setup-required reasons

`refineSnapshot` on the driver replaces the core's generic message.  The core
can only report that `--version` failed against `config.cli`, which here is
`python3 <bridge>` — a string that tells a user nothing they can act on.  The
driver names the missing piece instead: no Python 3, or a missing bundled
bridge, or no `dsh` on the machine with the install command to fix it.
