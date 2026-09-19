# Composio Fleet-Session for Personal Agents

BotFleet's product **Composio** integration (see [`docs/composio.md`](../composio.md))
runs on a per-installation basis — each desktop or web install mints its own
Composio session, with a stable Composio user generated locally and the user's
own `ak_…` project key.  That path is for *end users* of BotFleet.

This page covers a **separate** concern: the agents on this Mac — Mavis
(`[MM]`), Claude/Monet (`[CLAUDE]`), Cursor (`[CURSOR]`), Grok/Designer
(`[GROK]`), Codex (`[CODEX]`), Antigravity (`[AG]`) — sharing **one**
Composio `user_id` so a single Slack OAuth grant and a single GitHub OAuth
grant flow to every agent that runs on this machine.  Each agent still gets
its own session; what is shared is `user_id`, because Composio attaches
connected accounts to `user_id`, not to sessions.

This is the fix for the failure mode where one seat (Designer/Grok in the
2026-09-19 thread) had to shell out to "this Mac" over Docker-over-SSH just
to reach `gh`.  With the pattern below, every agent hits Composio directly;
one OAuth grant on any agent makes Slack and GitHub available on every agent.

## Why one `user_id` across seats

Composio's data model (see the broker at
`botfleet-claude-review/cloudflare/composio-broker/src/index.ts:330`):

- `connected_accounts` rows are filtered by `user_id`.
- Two sessions with the same `user_id` see the same connected accounts.
- Two sessions with different `user_ids` do not.

Every seat on this Mac should use the same `user_id` — `jay-fleet` is the
convention here — so:

- One Slack OAuth grant covers Mavis, Claude, Cursor, Grok, Codex, Antigravity.
- One GitHub OAuth grant covers the same.
- One `user_id` is ported to the BotFleet product broker so a personal
  Composio account also flows into a BotFleet installation when the owner
  wants it to.

Sessions are **not** shared: each agent's MCP client needs its own session
URL (the session ID is embedded in the URL and each session has its own TTL).
What is shared is `user_id`.

## Minting a session

The recipe lives at
[`scripts/composio-fleet-session.sh`](../../scripts/composio-fleet-session.sh)
in this repo.  The script:

- reads `COMPOSIO_API_KEY` from the environment, falling back to
  `~/.secrets/global-api-keys` (the `ak_…` project key lives there);
- POSTs to `https://backend.composio.dev/api/v3.1/tool_router/session` with
  `user_id=jay-fleet`, `manage_connections` enabled, and `multi_account`
  enabled with explicit selection;
- persists the returned `session_id` to `~/.secrets/composio-session-id`
  (chmod 600) so a follow-up `--check-only` can verify the session is still
  live without re-minting;
- optionally prints a paste-ready MCP config snippet for one of
  `--print-for claude-code|cursor|antigravity|grok|codex|json`.

```text
$ ./scripts/composio-fleet-session.sh
user_id:       jay-fleet
session_id:    trs_6dJZIVJegOw2
mcp_url:       https://backend.composio.dev/tool_router/trs_6dJZIVJegOw2/mcp
x-api-key:     ak_hhThj…(length 23)
persisted_to:  /Users/jay/.secrets/composio-session-id
```

The script is non-destructive: it only writes when called without
`--check-only` (which verifies a session already at `--out` is still valid
and re-prints without writing).

## Wiring each platform

The MCP URL and `x-api-key` from the script's output are the two pieces every
platform needs.  Where they go:

| Platform       | Config file or UI                                            | Notes                                                  |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Mavis (local)  | `~/.minimax/mcp.json`                                        | `streamable-http` transport, `x-api-key` header.       |
| Claude Code    | `~/.claude/mcp_servers.json`                                 | `type: http`, merge into existing `mcpServers`.       |
| Cursor         | `~/.cursor/mcp.json`                                         | `url` + `headers` shape (no `type`).                   |
| Antigravity    | Settings → Customizations → Open MCP Config                  | `serverUrl` + `headers` shape.                        |
| Grok           | Grok Connectors → New Connector → Custom (paid tier)         | Paste the URL, add `x-api-key` header.                |
| Codex          | `~/.codex/mcp_config.json` *or* `composio login` (plugin)    | Plugin path is shorter but writes to the same config. |

The script's `--print-for <platform>` flag prints a paste-ready JSON snippet
(or, for Grok, the URL + header pair) so the only thing an installer copies
is the output of one command.

## Connecting Slack and GitHub

Once the MCP server is wired into a platform and the platform reloads its
config, the agent discovers the connected-accounts state via the standard
Composio meta-tools (`COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MANAGE_CONNECTIONS`,
`COMPOSIO_WAIT_FOR_CONNECTIONS`).  On a fresh install with no Slack or
GitHub connected:

1. The agent calls `COMPOSIO_SEARCH_TOOLS` for the `slack` and `github`
   toolkits.
2. Composio returns a Connect Link for each toolkit; the agent surfaces it
   in chat.
3. The owner opens the link, signs in once, approves the OAuth grant.
4. Composio persists the connected account under `user_id=jay-fleet`.
5. Every other agent whose session uses `jay-fleet` sees the same account
   on its next MCP roundtrip.

The OAuth grant is one-time per app.  Re-authorising from another agent
re-prompts only if the grant was revoked.

## Session lifetime and renewal

A Platform session expires on Composio's clock — the TTL is not surfaced in
the API response, so a session should be treated as best-effort and renewed
on failure.  The recipe script supports both modes:

```text
$ ./scripts/composio-fleet-session.sh --check-only          # verify, don't mint
$ ./scripts/composio-fleet-session.sh                        # mint and persist
$ ./scripts/composio-fleet-session.sh --no-persist           # one-off mint
$ ./scripts/composio-fleet-session.sh --user-id jay-fleet-2  # second identity
```

When a session is dead, the MCP client receives an authentication failure on
its next tool call.  Re-run the script, paste the new URL + key into the
platform config, and reload — no other state changes.

For automation, the script returns a stable exit status and can be wired
into a session-start hook:

```bash
# Snippet for a per-platform session-renew hook
~/apps/botfleet-mm/composio-fleet-session.sh --check-only \
  || ~/apps/botfleet-mm/composio-fleet-session.sh
```

(Replace `~/apps/botfleet-mm/…` with the seat-local copy on the host that
runs the hook.)

## Sharing the same `user_id` with the BotFleet product

The BotFleet broker (Cloudflare Worker, `botfleet-composio`) currently
generates a fresh `composio_user_id` per BotFleet installation.  For a
personal fleet owner who already has a Composio account under
`jay-fleet`, adding a **"Connect with my existing Composio user_id"** field
in **App Settings → Connections** would let BotFleet link to the owner's
existing connected accounts instead of running a separate OAuth grant per
BotFleet install.

That is a product change — flag as a board item, not an agent change.

## Security notes

- The `ak_…` project key is the only credential in this recipe; it
  already lives in `~/.secrets/global-api-keys` (chmod 600) and is shared
  by every agent on this Mac.
- The MCP URL embeds the session ID.  Treat the URL as bearer-equivalent
  for the lifetime of the session.
- `~/.secrets/composio-session-id` is chmod 600 and contains only the
  session ID, not the API key.
- Connected-account OAuth grants live on Composio's side; the agent never
  sees the Slack or GitHub token directly.
