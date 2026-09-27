# Connector grants

The connector grants fixture verifies per-bot authorization for third-party tool providers like Composio.  Grants are stored per-bot and per-tool, and revocation is reflected immediately.

## Setup

```sh
pnpm test -- server/mcp-server.test.ts
```

This test suite:

1. Starts an isolated server with MCP connector configuration
2. Creates multiple bots with different tool grants
3. Tests authorization per bot and per tool
4. Simulates grant revocation
5. Verifies access control enforced at the relay

## Steps

```sh
# 1. Run the MCP server tests
pnpm test -- server/mcp-server.test.ts

# 2. Expected assertions:
# - Bot A with a Composio grant can call Composio tools
# - Bot B without the grant cannot call them
# - Revoking Bot A's grant immediately denies access
# - Tool filtering reflects configured grants
# - Listing tools returns only authorized tools per bot
```

## Expected Evidence

A passing run shows:

- **Test output:** All authorization and grant lifecycle tests pass
- **Access log:** Server logs show grant checks: `checking <bot>:<tool> — granted` or `denied`
- **Tool list:** The `/tools/list` endpoint filters results per bot's grants
- **Revocation:** After revoking a grant, the tool immediately becomes unavailable to that bot

## Key Behaviors Verified

- **Per-bot grants:** Each bot's grants are independent; one bot's revocation does not affect others
- **Per-tool authorization:** Grants are scoped to specific tools, not entire providers
- **Immediate revocation:** Revoking a grant takes effect on the next request with no cache delay
- **Tool filtering:** The `/tools/list` endpoint includes only authorized tools
- **Relay enforcement:** Authorization checks happen at the relay layer, before forwarding to the provider

## Related Configuration

Grants are configured through the bot's MCP settings and stored in the bot's persistent state.  The relay (`server/mcp-relay.ts`) enforces the grants before each tool invocation.

## Cleanup

The test suite cleans up automatically.  No manual cleanup is needed.
