import { describe, expect, it } from "vitest";

import { resolvePermissionAllowKey } from "./permission-allow-key.ts";

describe("resolvePermissionAllowKey", () => {
  it("prefers a configured MCP grant over native keys", () => {
    const cfg = {
      mcpServers: {
        linear: { command: "node", args: ["linear.js"] },
      },
    };
    const bot = { modelSelection: { instanceId: "claude" } };
    const read = resolvePermissionAllowKey(cfg, bot, "mcp__linear__list_issues", "list issues", {});
    expect(read.allowKey).toMatch(/^provider-tool:claude:linear:list_issues:/);
    expect(read.allowKeyWarnWrite).toBe(false);

    const write = resolvePermissionAllowKey(cfg, bot, "mcp__linear__create_issue", "create issue", {});
    expect(write.allowKey).toMatch(/^provider-tool:claude:linear:create_issue:/);
    expect(write.allowKeyWarnWrite).toBe(true);

    const compound = resolvePermissionAllowKey(cfg, bot, "mcp__linear__get_or_create_project", "get or create", {});
    expect(compound.allowKeyWarnWrite).toBe(true);
  });

  it("falls back to native offerable keys", () => {
    const bot = { modelSelection: { instanceId: "claude" } };
    const resolved = resolvePermissionAllowKey({ }, bot, "Read", "src/index.ts", {});
    expect(resolved.allowKey).toBe("Read");
  });
});
