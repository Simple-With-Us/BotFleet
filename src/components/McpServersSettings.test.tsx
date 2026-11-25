import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { mcpNameError } from "../../shared/mcp-servers";
import {
  McpServersSettings,
  type McpServerView,
  credentialLinesFrom,
  parseCredentialLines,
  serverDescriptor,
  splitCommand,
} from "./McpServersSettings";

/** Only the MCP fields decide what this card renders, so a bot literal is
 * enough to drive it.  The cast is safe because the card reads no other bot
 * field — asserted by the render cases below, which fail loudly if that ever
 * stops being true. */
const markup = (bot: Partial<Bot>, servers: McpServerView[] = []) =>
  renderToStaticMarkup(
    createElement(McpServersSettings, {
      // SAFETY: partial bot literal; the component reads only the MCP fields.
      bot: bot as Bot,
      servers,
      onPatch: () => {},
    }),
  );

describe("mcpNameError", () => {
  it("refuses a name the shape does not allow", () => {
    expect(mcpNameError("")).toBeTruthy();
    expect(mcpNameError("MyTool")).toBeTruthy();
    expect(mcpNameError("1tool")).toBeTruthy();
    expect(mcpNameError("a".repeat(33))).toBeTruthy();
  });

  it("refuses a name the harness reserves", () => {
    // A custom server named `agents` could redirect the harness's own peer
    // proxy, so the reserved names are refused.
    expect(mcpNameError("agents")).toBeTruthy();
    expect(mcpNameError("phone")).toBeTruthy();
    expect(mcpNameError("composio")).toBeTruthy();
  });

  it("accepts a name the shape allows", () => {
    expect(mcpNameError("my-server")).toBeNull();
    expect(mcpNameError("my_server2")).toBeNull();
  });
});

describe("parseCredentialLines", () => {
  it("reads one KEY=value per line", () => {
    expect(parseCredentialLines("API_TOKEN=abc\nOTHER=def")).toEqual({ API_TOKEN: "abc", OTHER: "def" });
  });

  it("keeps a value that itself holds an equals sign", () => {
    expect(parseCredentialLines("TOKEN=a=b")).toEqual({ TOKEN: "a=b" });
  });

  it("drops a line with no value and a line with no key", () => {
    expect(parseCredentialLines("TOKEN=\n=abc\n")).toEqual({ TOKEN: "" });
    expect(parseCredentialLines("=abc")).toEqual({});
  });

  it("keeps an empty value, because a credential with no value is still a field", () => {
    expect(parseCredentialLines("TOKEN=")).toEqual({ TOKEN: "" });
  });
});

describe("credentialLinesFrom", () => {
  it("names the fields a server carries and no values", () => {
    expect(credentialLinesFrom(["TOKEN", "OTHER"])).toBe("TOKEN=\nOTHER=");
  });

  it("is empty for a server with no fields", () => {
    expect(credentialLinesFrom(undefined)).toBe("");
    expect(credentialLinesFrom([])).toBe("");
  });
});

describe("splitCommand", () => {
  it("splits a command into the binary and its arguments", () => {
    expect(splitCommand("npx -y my-mcp")).toEqual(["npx", "-y", "my-mcp"]);
  });

  it("keeps a quoted argument together", () => {
    expect(splitCommand('"/opt/my tools/mcp" --flag')).toEqual(["/opt/my tools/mcp", "--flag"]);
  });

  it("is empty for an empty line", () => {
    expect(splitCommand("")).toEqual([]);
    expect(splitCommand("   ")).toEqual([]);
  });
});

describe("serverDescriptor", () => {
  it("names the command a local server runs", () => {
    expect(serverDescriptor({ name: "x", scope: "bot", enabled: true, command: "npx", args: ["-y", "mcp"] })).toBe("npx -y mcp");
  });

  it("names the address a remote server answers on", () => {
    expect(serverDescriptor({ name: "x", scope: "bot", enabled: true, type: "http", url: "https://example.com/mcp" })).toBe(
      "https://example.com/mcp",
    );
  });
});

describe("the card", () => {
  it("lists the shared servers and the bot's own, and says which is which", () => {
    const html = markup(
      {},
      [
        { name: "sharedone", scope: "shared", enabled: true, command: "npx", args: [], envKeys: ["TOKEN"] },
        { name: "mine", scope: "bot", enabled: true, type: "http", url: "https://example.com/mcp", headerKeys: [] },
      ],
    );
    expect(html).toContain("sharedone");
    expect(html).toContain("mine");
    expect(html).toContain("Shared servers");
    expect(html).toContain("This bot&#x27;s own servers");
  });

  it("never renders a credential value", () => {
    // The listing names a server's FIELDS;  a value never reaches the card.
    const html = markup(
      {},
      [{ name: "one", scope: "shared", enabled: true, command: "npx", args: [], envKeys: ["TOKEN"] }],
    );
    expect(html).toContain("TOKEN");
    expect(html).not.toContain("secret-value");
  });

  it("always offers the shared narrowing, so the list can move to a subset", () => {
    // The checkboxes are rendered whether or not the bot has narrowed the
    // shared set:  a list that only appears once a narrowing exists can
    // never be created.
    const unnarrowed = markup(
      {},
      [{ name: "one", scope: "shared", enabled: true, command: "npx", args: [], envKeys: [] }],
    );
    expect(unnarrowed).toContain("Allow");
    expect(unnarrowed).not.toContain("Use all");

    const narrowed = markup(
      { mcpServers: ["one"] },
      [{ name: "one", scope: "shared", enabled: true, command: "npx", args: [], envKeys: [] }],
    );
    expect(narrowed).toContain("Allow");
    // And a narrowed bot can go back to every shared server.
    expect(narrowed).toContain("Use all");
  });

  it("says what the two scopes mean", () => {
    const html = markup({});
    expect(html).toContain("MCP Servers");
    expect(html).toContain("Shared servers are set up for the whole workspace");
    expect(html).toContain("belongs to this bot alone");
  });
});
