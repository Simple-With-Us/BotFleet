import { afterEach, describe, expect, it } from "vitest";
import { resetSentryForTests, setSentryLoaderForTests, applySentryConfig, isSentryActive } from "./sentry.ts";
import { withMcpToolCallSpan } from "./sentry-mcp.ts";

afterEach(() => {
  resetSentryForTests();
});

describe("withMcpToolCallSpan", () => {
  it("is a passthrough when Sentry is inactive", async () => {
    const value = await withMcpToolCallSpan({ toolName: "list_bots" }, async () => 42);
    expect(value).toBe(42);
    expect(isSentryActive()).toBe(false);
  });

  it("opens an mcp.server tools/call span when Sentry is active", async () => {
    const spans: Array<{ op?: string; name?: string; attributes?: Record<string, unknown> }> = [];
    const sdk = {
      init() {},
      close() {
        return Promise.resolve(true);
      },
      addIntegration() {},
      consoleLoggingIntegration() {
        return { name: "ConsoleLogs" };
      },
      startSpan(opts: { op?: string; name?: string; attributes?: Record<string, unknown> }, fn: (span: { setAttribute: (k: string, v: unknown) => void }) => Promise<unknown>) {
        const attrs = { ...(opts.attributes ?? {}) };
        spans.push({ op: opts.op, name: opts.name, attributes: attrs });
        return fn({
          setAttribute: (k, v) => {
            attrs[k] = v;
          },
        });
      },
    } as unknown as typeof import("@sentry/node");
    setSentryLoaderForTests(async () => sdk);
    await applySentryConfig({
      dsn: "https://abc123@o0.ingest.sentry.io/1",
      enabled: true,
      environment: "test",
      tracesSampleRate: 1,
      logsEnabled: false,
      source: "config",
    });
    expect(isSentryActive()).toBe(true);
    await withMcpToolCallSpan({ toolName: "list_bots", requestId: 7 }, async () => "ok");
    expect(spans).toHaveLength(1);
    expect(spans[0].op).toBe("mcp.server");
    expect(spans[0].name).toBe("tools/call list_bots");
    expect(spans[0].attributes?.["mcp.tool.name"]).toBe("list_bots");
    expect(spans[0].attributes?.["mcp.method.name"]).toBe("tools/call");
    expect(spans[0].attributes?.["mcp.request.id"]).toBe("7");
    expect(spans[0].attributes?.["mcp.tool.result.is_error"]).toBe(false);
  });
});
