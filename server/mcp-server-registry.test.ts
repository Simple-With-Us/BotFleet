/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- The fixtures build a stored entry and a config map from the shapes the registry reads, and a test fixture is not the dispatch's own object. */
import { describe, expect, it } from "vitest";

import {
  MAX_BOT_MCP_SERVERS,
  botMcpServers,
  listMcpServersForBot,
  mcpServersForTurn,
  parseMcpServerEntry,
  resolveMcpServers,
  sharedMcpServers,
} from "./mcp-server-registry.ts";
import type { AppConfig } from "./config.ts";
import type { StoredMcpServer } from "./mcp-registry.ts";
import type { JsonValue } from "./schema.ts";
import type { BotRecord } from "./store.ts";

/** A config with the workspace's shared servers in it.
 *
 * The stored map is the config's own JSON type, so the fixture builds one
 * rather than asserting an unrelated shape into it. */
function config(servers: Record<string, JsonValue>): AppConfig {
  // SAFETY: a test fixture carries only the one field the resolver reads,
  // and the resolver never reads anything else off the config.
  return { mcpServers: servers } as AppConfig;
}

/** A bot with no MCP servers of its own. */
function bot(overrides: Partial<Pick<BotRecord, "mcpServers" | "ownMcpServers">> = {}): Pick<
  BotRecord,
  "mcpServers" | "ownMcpServers"
> {
  return { ...overrides };
}

/** A stored server of the bot's own, in the shape the record holds.
 *
 * The stored shape is the registry's own, so the fixture builds one field
 * at a time rather than asserting an unrelated object into it.  The
 * defaults fill in the fields a KIND of server carries and no other:  a
 * server has either a command or an address, never both, so the fixture
 * must not put a command on a remote one. */
function ownServer(server: OwnServerFields): BotRecord["ownMcpServers"] {
  // A stored server is one kind or the other, so the fixture names the
  // kind it builds rather than asserting a union.
  const remote = server.url !== undefined;
  const base = remote
    ? { type: "http" as const, url: "", headers: {}, enabled: true }
    : { command: "", args: [], env: {}, enabled: true };
  return { mine: { ...base, ...server } as StoredMcpServer };
}

// The stored shapes, typed as the config's own JSON value so a fixture
// never has to assert an unrelated object into the parser's boundary.
/** The fields a fixture may name for a stored server of the bot's own. */
interface OwnServerFields {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

const LOCAL: JsonValue = { command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret-value" } };
const REMOTE: JsonValue = { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } };

describe("parsing one MCP server", () => {
  it("reads a local server", () => {
    const parsed = parseMcpServerEntry("mytool", LOCAL);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.server).toEqual({ command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret-value" }, enabled: true });
  });

  it("reads a remote server", () => {
    const parsed = parseMcpServerEntry("mytool", REMOTE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.server).toEqual({ type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" }, enabled: true });
  });

  it("refuses a name the registry reserves or the shape does not allow", () => {
    // A custom server named `agents` could redirect the harness's own peer
    // proxy, so the reserved names are refused.
    expect(parseMcpServerEntry("agents", LOCAL).ok).toBe(false);
    expect(parseMcpServerEntry("MyTool", LOCAL).ok).toBe(false);
    expect(parseMcpServerEntry("", LOCAL).ok).toBe(false);
    // Neither a command nor a url is not a server.
    expect(parseMcpServerEntry("mytool", { args: [] }).ok).toBe(false);
  });

  it("refuses an env name the harness owns", () => {
    const parsed = parseMcpServerEntry("mytool", { command: "npx", env: { OMB_CONTROL_TOKEN: "x" } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("reserved");
  });

  it("reads a disabled server as a server that is off", () => {
    const parsed = parseMcpServerEntry("mytool", { ...LOCAL, enabled: false });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.server.enabled).toBe(false);
  });
});

describe("the workspace's shared servers", () => {
  it("mounts every enabled shared server when the bot narrows nothing", () => {
    const servers = sharedMcpServers(config({ one: LOCAL, two: REMOTE }));
    expect(Object.keys(servers)).toEqual(["one", "two"]);
  });

  it("mounts only the names the bot's list names", () => {
    const servers = sharedMcpServers(config({ one: LOCAL, two: REMOTE }), ["two"]);
    expect(Object.keys(servers)).toEqual(["two"]);
  });

  it("mounts no disabled server", () => {
    const servers = sharedMcpServers(config({ one: { ...LOCAL, enabled: false } }));
    expect(servers).toEqual({});
  });

  it("skips a broken entry rather than failing", () => {
    const servers = sharedMcpServers(config({ good: LOCAL, broken: { args: [] } }));
    expect(Object.keys(servers)).toEqual(["good"]);
  });
});

describe("a bot's own servers", () => {
  it("reads them from the bot record", () => {
    const servers = botMcpServers(bot({ ownMcpServers: ownServer({ command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret-value" } }) }));
    expect(Object.keys(servers)).toEqual(["mine"]);
  });

  it("mounts none when the bot has none", () => {
    expect(botMcpServers(bot())).toEqual({});
  });

  it("mounts no disabled server of its own", () => {
    const servers = botMcpServers(bot({ ownMcpServers: ownServer({ command: "npx", args: [], env: {}, enabled: false }) }));
    expect(servers).toEqual({});
  });
});

describe("resolving what a bot may mount", () => {
  it("mounts the shared servers and the bot's own", () => {
    const { servers, scopes } = resolveMcpServers(
      config({ sharedone: LOCAL }),
      bot({ ownMcpServers: ownServer({ command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret-value" } }) }),
    );
    expect(Object.keys(servers).sort()).toEqual(["mine", "sharedone"]);
    expect(scopes.sharedone).toBe("shared");
    expect(scopes.mine).toBe("bot");
  });

  it("lets the bot's own server win a name the workspace also has", () => {
    const { servers, scopes } = resolveMcpServers(
      config({ mine: { command: "workspace-one" } }),
      bot({ ownMcpServers: ownServer({ command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret-value" } }) }),
    );
    expect(scopes.mine).toBe("bot");
    if (!("command" in servers.mine)) throw new Error("expected a local server");
    expect(servers.mine.command).toBe("npx");
  });

  it("narrows the shared set to the bot's list", () => {
    const { servers } = resolveMcpServers(
      config({ one: LOCAL, two: REMOTE }),
      bot({ mcpServers: ["two"] }),
    );
    expect(Object.keys(servers)).toEqual(["two"]);
  });

  it("mounts the bot's own even when the shared set is narrowed away", () => {
    const { servers } = resolveMcpServers(
      config({ one: LOCAL }),
      bot({ mcpServers: ["other"], ownMcpServers: ownServer({ command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret-value" } }) }),
    );
    expect(Object.keys(servers)).toEqual(["mine"]);
  });
});

describe("the shape a turn mounts", () => {
  it("carries the spec and nothing the turn does not need", () => {
    const { servers } = resolveMcpServers(
      config({ one: LOCAL }),
      bot({ ownMcpServers: { two: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" }, enabled: true } } }),
    );
    const turn = mcpServersForTurn(servers);
    // The switch that says whether the server is on and a remote server's
    // sign-in app are the registry's business, not the engine's.
    expect(turn.one).toEqual({ command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret-value" } });
    expect(turn.two).toEqual({ type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } });
    expect(Object.keys(turn.one)).not.toContain("enabled");
    expect(Object.keys(turn.two)).not.toContain("enabled");
  });

  it("copies the values, so a later change cannot reach a mounted turn", () => {
    const { servers } = resolveMcpServers(config({ one: LOCAL }), bot());
    const turn = mcpServersForTurn(servers);
    if (!("env" in turn.one)) throw new Error("expected a local server");
    turn.one.env.TOKEN = "changed";
    expect(servers.one).toBeDefined();
    if (!("env" in servers.one!)) throw new Error("expected a local server");
    expect(servers.one.env.TOKEN).toBe("secret-value");
  });
});

describe("what the person sees", () => {
  it("lists both scopes and names the secret fields without their values", () => {
    const views = listMcpServersForBot(
      config({ sharedone: LOCAL }),
      bot({ ownMcpServers: ownServer({ type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } }) }),
    );
    expect(views.map((view) => view.name)).toEqual(["mine", "sharedone"]);
    const local = views.find((view) => view.name === "sharedone");
    expect(local).toBeDefined();
    if (!local || !("envKeys" in local)) throw new Error("expected a local server");
    expect(local.envKeys).toEqual(["TOKEN"]);
    expect(local.scope).toBe("shared");
    // The value itself never appears in the listing.
    expect(JSON.stringify(views)).not.toContain("secret-value");
  });

  it("lists a remote server's header names and not its values", () => {
    const views = listMcpServersForBot(config({ remoteone: REMOTE }), bot());
    expect(views).toHaveLength(1);
    const view = views[0];
    if (!view || !("headerKeys" in view)) throw new Error("expected a remote server");
    expect(view.headerKeys).toEqual(["Authorization"]);
    expect(JSON.stringify(views)).not.toContain("Bearer x");
  });

  it("lists a bot's own server as the bot's", () => {
    const views = listMcpServersForBot(
      config({}),
      bot({ ownMcpServers: ownServer({ command: "npx", args: ["-y", "my-mcp"], env: { TOKEN: "secret-value" } }) }),
    );
    expect(views).toHaveLength(1);
    expect(views[0].scope).toBe("bot");
  });
});

describe("the rules a stored entry has to keep", () => {
  it("refuses an entry that carries both a command and an address", () => {
    // The remote shape would win and the command would be dropped without
    // a word, so the entry would mount the wrong transport.
    const parsed = parseMcpServerEntry("both", { command: "npx", url: "https://example.com/mcp" } as JsonValue);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("not both");
  });

  it("refuses an entry that carries neither", () => {
    expect(parseMcpServerEntry("neither", { args: [] } as JsonValue).ok).toBe(false);
  });

  it("refuses an address that is not a full http(s) URL", () => {
    expect(parseMcpServerEntry("bad", { url: "example.com/mcp" } as JsonValue).ok).toBe(false);
    expect(parseMcpServerEntry("creds", { url: "https://example.com/mcp", headers: { Authorization: "x" } } as JsonValue).ok).toBe(true);
  });

  it("refuses an environment variable the harness owns", () => {
    const parsed = parseMcpServerEntry("mine", { command: "npx", env: { OMB_CONTROL_TOKEN: "x" } } as JsonValue);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("reserved");
  });

  it("refuses an unknown field rather than dropping it", () => {
    expect(parseMcpServerEntry("mine", { command: "npx", enve: {} } as JsonValue).ok).toBe(false);
  });

  it("refuses a bot's own server that breaks the same rules", () => {
    // The bot's own entries go through the same parser as the shared ones,
    // so a malformed or reserved one cannot mount.
    const servers = botMcpServers({
      ownMcpServers: {
        good: { command: "npx", args: [], env: {}, enabled: true },
        bad: { command: "npx", args: [], env: { OMB_CONTROL_TOKEN: "x" }, enabled: true },
      } as never,
    });
    expect(Object.keys(servers)).toEqual(["good"]);
  });
});

describe("a disabled server", () => {
  it("does not mount", () => {
    const servers = sharedMcpServers(config({ off: { ...LOCAL, enabled: false } as JsonValue }));
    expect(servers).toEqual({});
  });

  it("stays visible in the listing, so it can be turned back on or removed", () => {
    const views = listMcpServersForBot(config({ off: { ...LOCAL, enabled: false } as JsonValue }), bot());
    expect(views.map((view) => view.name)).toEqual(["off"]);
    expect(views[0].enabled).toBe(false);
  });
});

describe("the bound on a bot's own servers", () => {
  it("is the same bound the workspace's registry keeps", () => {
    expect(MAX_BOT_MCP_SERVERS).toBe(20);
  });
});
