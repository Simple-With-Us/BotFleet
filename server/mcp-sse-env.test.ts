import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regression cover for the adapter installing its default harness URL.  The
// tools layer (scripts/mcp-server.ts) captures BOTFLEET_URL at module scope, so
// an assignment placed after a static import is dead code: configuredUrl stays
// undefined, the tool layer falls back to probing loopback ports 8799/18799/
// 28799, and -- with BOTFLEET_TOKEN set -- resolveBaseUrl() refuses with
// "Set BOTFLEET_URL or OMB_PORT".  This file therefore leaves BOTFLEET_URL
// unset and asserts the default is installed before that module is evaluated.
const savedEnv = { ...process.env };
const DEFAULT_HARNESS = "http://127.0.0.1:8799";

describe("MCP HTTP/SSE adapter harness URL default", () => {
  beforeAll(() => {
    delete process.env.BOTFLEET_URL;
    delete process.env.OPENMAUSBOT_URL;
    delete process.env.OMB_PORT;
    // A token is what makes the un-configured case throw the config error
    // rather than silently probing: it is the guard against leaking the harness
    // bearer to whatever answers on a discovered port.
    const canary = `test-token-${Date.now()}`;
    process.env.BOTFLEET_TOKEN = canary;
    process.env.BOTFLEET_MCP_TOKEN = canary;
    process.env.BOTFLEET_MCP_HOST = "127.0.0.1";
    process.env.BOTFLEET_MCP_PORT = "39794";
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it("resolves the default harness instead of requiring BOTFLEET_URL", async () => {
    await import("../scripts/mcp-sse.ts");
    const { resolveBaseUrl } = await import("../scripts/mcp-server.ts");

    try {
      expect(await resolveBaseUrl()).toBe(DEFAULT_HARNESS);
    } catch (err) {
      // No harness listening in this environment: the failure must be the
      // connection failure, never the "you did not configure a URL" refusal
      // that the dead assignment produced.
      expect(err instanceof Error ? err.message : String(err)).not.toMatch(/OMB_PORT/);
    }
  });
});
