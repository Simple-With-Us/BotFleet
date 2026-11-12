import { describe, expect, it } from "vitest";

import {
  FOREIGN_LOOPBACK_PORTS,
  foreignLoopbackOwner,
  formatListenInUse,
  isListenInUse,
  listenErrorDisposition,
  resolveHarnessPort,
  resolvePort,
  resolveWebhookPort,
} from "./harness-ports.ts";

describe("foreign loopback ports", () => {
  it("names the Mac services that often own 8791-8793", () => {
    expect(FOREIGN_LOOPBACK_PORTS).toEqual([8791, 8792, 8793]);
    expect(foreignLoopbackOwner(8791)).toBe("xcode-health");
    expect(foreignLoopbackOwner(8792)).toBe("mac-collab");
    expect(foreignLoopbackOwner(8793)).toBe("seat-mcp");
    expect(foreignLoopbackOwner(8799)).toBeNull();
    expect(foreignLoopbackOwner(8800)).toBeNull();
  });

  it("does not reserve 8791-8793 before a bind", () => {
    expect(formatListenInUse(8793, "harness")).toMatch(/already in use/);
    expect(formatListenInUse(8793, "harness")).toContain("seat-mcp");
    expect(formatListenInUse(8799, "harness")).toBe(
      "botfleet harness: 127.0.0.1:8799 is already in use",
    );
  });

  it("detects EADDRINUSE from a Node listen error", () => {
    expect(isListenInUse({ code: "EADDRINUSE" })).toBe(true);
    expect(isListenInUse(new Error("listen EADDRINUSE"))).toBe(false);
    expect(isListenInUse(null)).toBe(false);
  });

  it("captures unexpected listen errors instead of dropping them", () => {
    expect(listenErrorDisposition({ code: "EADDRINUSE" })).toBe("named-exit");
    expect(listenErrorDisposition({ code: "EACCES" })).toBe("capture-and-exit");
    expect(listenErrorDisposition({ code: "EMFILE" })).toBe("capture-and-exit");
  });
});

describe("port env resolution", () => {
  it("falls back on non-numeric, fractional, and out-of-range values", () => {
    expect(resolvePort(undefined, 8799)).toBe(8799);
    expect(resolvePort("", 8799)).toBe(8799);
    expect(resolvePort("abc", 8799)).toBe(8799);
    expect(resolvePort("8799.5", 8799)).toBe(8799);
    expect(resolvePort("0", 8799)).toBe(8799);
    expect(resolvePort("65536", 8799)).toBe(8799);
    expect(resolvePort("9000", 8799)).toBe(9000);
    expect(resolvePort("0x1F90", 8799)).toBe(8799);
    expect(resolvePort("1e3", 8799)).toBe(8799);
    expect(resolvePort("+9000", 8799)).toBe(8799);
    expect(resolvePort(" 9000 ", 8799)).toBe(9000);
  });

  it("resolves the harness and webhook ports from env", () => {
    expect(resolveHarnessPort({})).toBe(8799);
    expect(resolveHarnessPort({ OMB_PORT: "9100" })).toBe(9100);
    expect(resolveHarnessPort({ OGB_PORT: "9200" })).toBe(9200);
    expect(resolveHarnessPort({ OMB_PORT: "nope", OGB_PORT: "9200" })).toBe(9200);
    expect(resolveWebhookPort({}, 8799)).toBe(8800);
    expect(resolveWebhookPort({ OMB_WEBHOOK_PORT: "9900" }, 8799)).toBe(9900);
    expect(resolveWebhookPort({ OMB_WEBHOOK_PORT: "nope" }, 8799)).toBe(8800);
    expect(resolveWebhookPort({}, 65535)).toBe(65534);
  });
});
