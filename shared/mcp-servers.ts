// The MCP server shape, shared by the server, the client and the panel.
//
// One definition, so the writer and the reader cannot disagree about what a
// server is.  A server is either a command this machine runs or a URL to
// connect to, and the credentials it carries are write-only:  the listing
// names the FIELDS a server carries and never their values.

/** One MCP server as it is stored and as a patch carries it. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/** The name rules the registry shares with the client:  lowercase, and
 * starting with a letter. */
export const MCP_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** The names the harness reserves for its own proxies. */
export const MCP_RESERVED_NAMES: readonly string[] = [
  "agents",
  "browser",
  "composio",
  "computer",
  "data",
  "dweb",
  "ogb",
  "openmausbot_connectors",
  "openmausbot_phone",
  "phone",
];

/** Why a name cannot be used, or null when it can. */
export function mcpNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the server a name.";
  if (!MCP_NAME_PATTERN.test(trimmed)) {
    return "Use 1–32 lowercase letters, numbers, underscores, or hyphens, starting with a letter.";
  }
  if (MCP_RESERVED_NAMES.includes(trimmed)) return "That name is reserved by BotFleet.";
  return null;
}
