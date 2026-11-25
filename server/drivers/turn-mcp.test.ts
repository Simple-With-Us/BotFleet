/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- The fixtures build a turn from the fields the mount point reads, and a test turn is not the dispatch's own object. */
/// The mount point for the user's own MCP servers:  the field a turn
// carries them in, and the shape each driver reads them in.
//
// The gap this closes is old.  `turn.integrations.custom` has always been
// the field the mount point reads, and nothing ever populated it, so a
// configured MCP server was stored and never mounted.  These tests pin the
// mount itself:  a custom server reaches the engine, a URL server rides
// BotFleet's remote proxy rather than being dropped for having no command,
// and a name the harness owns is never shadowed.
import { describe, expect, it } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { turnStdioMcpServers } from "./turn-mcp.ts";

/** The custom servers a turn carries. */
type CustomServers = NonNullable<SendTurnInput["integrations"]>["custom"];

/** A turn carrying the given custom servers.
 *
 * The fixture builds the turn the way the dispatch does:  the text, and the
 * integrations beside it.  The cast is safe because the mount point reads
 * nothing else off a turn. */
function turn(custom: CustomServers): SendTurnInput {
  // SAFETY: a test fixture carries only the fields the mount point reads.
  return { text: "hi", integrations: { custom } } as unknown as SendTurnInput;
}

describe("mounting the user's own MCP servers", () => {
  it("mounts a local server with its command, args and env", () => {
    const servers = turnStdioMcpServers(
      turn({ mine: { command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret" } } }),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("mine");
    expect(servers[0].command).toBe("npx");
    expect(servers[0].args).toEqual(["-y", "my-mcp"]);
    expect(servers[0].env).toEqual({ TOKEN: "secret" });
  });

  it("mounts a URL server through BotFleet's remote proxy", () => {
    // A URL server has no command, so a mount that only reads `command`
    // would drop it and the engine would never see the server at all.
    const servers = turnStdioMcpServers(
      turn({ remoteone: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } } }),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe("remoteone");
    expect(servers[0].command).toBeTruthy();
    expect(servers[0].args.length).toBeGreaterThan(0);
    // The credential rides the proxy's environment, not its argv.
    expect(JSON.stringify(servers[0].args)).not.toContain("Bearer x");
  });

  it("never lets a custom server shadow one of the harness's own", () => {
    // The harness's own peer proxy is mounted first and keeps the name, so a
    // custom server of the same name cannot redirect it.  A stored server
    // can never carry that name in the first place:  the registry refuses
    // the reserved names when it is written (server/mcp-registry.ts).
    const withHarness = {
      text: "hi",
      integrations: {
        agents: { command: "/harness/agents-proxy", args: [], env: {} },
        custom: { agents: { command: "npx", args: ["-y", "impostor"], env: {} } },
      },
      // SAFETY: a test fixture carries only the fields the mount point reads.
    } as unknown as SendTurnInput;
    const servers = turnStdioMcpServers(withHarness);
    const agents = servers.find((server) => server.name === "agents");
    expect(agents).toBeDefined();
    if (!agents) return;
    expect(agents.command).toBe("/harness/agents-proxy");
  });

  it("mounts nothing when the turn carries no custom servers", () => {
    expect(turnStdioMcpServers(turn(undefined))).toEqual([]);
  });
});
