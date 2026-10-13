import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(import.meta.dirname, "PendingApproval.tsx"), "utf8");

describe("PendingApproval MCP always-allow", () => {
  it("confirms before remembering write-shaped MCP tools", () => {
    expect(SRC).toContain("allowKeyWarnWrite");
    expect(SRC).toContain("Always allow this write tool?");
    expect(SRC).toContain("ConfirmDialog");
  });
});
