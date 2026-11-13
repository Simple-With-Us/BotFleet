# BotFleet MCP Server

The BotFleet desktop app includes a local stdio MCP server.  It lets another MCP client coordinate your
BotFleet team while the desktop app and its harness are running.

## What It Can Do

- list bots and channels, including their active task and current activity;
- read bounded transcript pages and search local transcripts without returning screenshot pixels;
- create and safely edit bot profiles, channels, and separate task conversations;
- send work to a bot or channel, learn whether it started, steered, or queued, wait for either conversation
  to settle or need help, and interrupt its active turn;
- list the approval and question cards still waiting on a person, and answer one of them once;
- list routines and queue one to run now, list webhook triggers, and read the authorization decision log;
- bring the desktop app to the front on the computer that runs it;
- list configured model instances and switch an idle bot to an exact available model.

The server intentionally cannot remember permission grants ("always allow"), delete data, import teams,
change credentials, mint or rotate webhook secrets, or control computer/VM lifecycle.  Those actions stay
in the human-facing app.

## From a Source Checkout

Start BotFleet, then configure the MCP client to run:

```json
{
  "mcpServers": {
    "botfleet": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/BotFleet", "mcp"]
    }
  }
}
```

## From the Installed Desktop App

Release builds bundle `server/mcp-server.js` and can run it with Electron's embedded Node runtime, so users do
not need Node.js or pnpm installed.

macOS example:

```json
{
  "mcpServers": {
    "botfleet": {
      "command": "/Applications/BotFleet.app/Contents/MacOS/BotFleet",
      "args": ["/Applications/BotFleet.app/Contents/Resources/server/mcp-server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

On Windows, use the installed `BotFleet.exe` as `command`, the adjacent
`resources\\server\\mcp-server.js` as the argument, and the same `ELECTRON_RUN_AS_NODE=1` environment value.
The usual per-user install is under `%LOCALAPPDATA%\\Programs\\BotFleet`.

On Ubuntu `.deb` installs, the executable is normally `/opt/BotFleet/botfleet` and the script is
`/opt/BotFleet/resources/server/mcp-server.js`.  Use the same environment value.

## Connection Discovery

With no configuration, the MCP process probes BotFleet's three desktop ports (`8799`, `18799`, and `28799`)
and accepts only a health response that identifies itself as BotFleet.  This handles the desktop's normal
fallback when another local process already owns port 8799.

Set `OMB_PORT` to force one local port, or `BOTFLEET_URL` to use an explicit HTTP(S) origin.  Cleartext remote
HTTP is rejected unless `ALLOW_INSECURE_HTTP=true`; HTTPS should be used outside loopback.  An optional
`BOTFLEET_TOKEN` is sent as a bearer token for authenticated reverse proxies.  When a token is set, an
explicit `BOTFLEET_URL` or `OMB_PORT` is required so the credential is never sent while probing unrelated
local ports.  `BOTFLEET_MCP_TIMEOUT_MS` can set an HTTP timeout between 1,000 and 120,000 milliseconds.

## One-Shot Pipe Drivers

A script may write its whole request batch to stdin and close it at once (`printf ... | pnpm mcp`).  Calls
that are still running when stdin closes keep running and still answer; only calls that outlive the drain
grace are cancelled.  `BOTFLEET_MCP_DRAIN_MS` sets that grace between 0 and 600,000 milliseconds (default
130,000, which covers the longest `wait_for_conversation` plus one HTTP timeout).

## Tools

| Purpose | Tools |
|---|---|
| Inspect | `get_system_health`, `list_bots`, `list_channels`, `get_bot_messages`, `get_channel_messages`, `search_messages`, `list_available_models` |
| Create and organize | `create_bot`, `update_bot_profile`, `create_channel`, `update_channel`, `create_task`, `switch_task`, `rename_task` |
| Run work | `send_bot_message`, `send_channel_message`, `wait_for_conversation`, `interrupt_conversation`, `set_bot_model` |
| Approvals | `list_pending_approvals`, `answer_approval` |
| Automation | `list_routines`, `run_routine`, `list_webhooks`, `read_decision_log` |
| Desktop | `open_app` |

`wait_for_conversation` returns `settled`, `needs-user`, `failed`, `stalled`, or `timed-out`, along with a
small redacted transcript tail.  MCP cancellation is honored while a tool is waiting.

`send_bot_message` and `send_channel_message` return an `outcome` of `started` (a new turn), `steered` (the
text reached the live turn), or `queued` (it waits behind the live turn, with a `queueId`).  Pass an
optional `idempotency_key`; a retry with the same key within ten minutes replays the first outcome with
`replayed: true` instead of sending the instruction twice.

`list_pending_approvals` reads the active task of every bot and channel (or only the one named) and returns
each open card with its `task_id` and `request_id`.  `answer_approval` sends the same request the desktop
sends: `allow` or `deny` once, or `answer` with a `message`.  When the request is no longer open the harness
reports `outcome: "unavailable"` and `delivered: false`; nothing ran and the card was closed.

`open_app` asks the harness to bring the desktop to the front.  The MCP process only asks when it is
talking to a loopback endpoint, the harness only honors a loopback connection, and the action is a fixed
`open -a BotFleet` on macOS; other platforms answer with an honest error.

## Safety and Data Scope

Transcript reads are paged and capped at 200 messages.  Search is capped at 100 hits.  Screenshot pixels and
remembered permission grant keys are removed from MCP results; `list_pending_approvals` exposes a card's
request ID so it can be answered once, never its grant key.  Routine, webhook, and run text is bounded, and
webhook listings never include secrets, capability URLs, or captured payloads.  Tool schemas reject unknown
fields and malformed values, and model changes are refused while a bot is working.

The harness itself is local-first and normally binds to loopback.  If you expose it through a reverse proxy,
authentication and TLS at that proxy are part of your deployment's security boundary.
