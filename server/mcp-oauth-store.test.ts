/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-shape-in-symbol-names, anti-slop/no-chained-type-assertions -- OpenMausBot MCP reliability port: JSON-RPC, HTTP, and OAuth boundary parsing with hand-rolled guards. */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpOAuthStore } from "./mcp-oauth-store.ts";

const URL_A = "https://mcp.example.com/mcp";
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-oauth-store-"));
  file = join(dir, "mcp-oauth.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("McpOAuthStore", () => {
  it("writes an owner-only file and reads a record back", () => {
    const store = new McpOAuthStore(file);
    store.put("docs", { url: URL_A, state: "signed-in", clientId: "c1", tokens: { access: "at", refresh: "rt", expiresAt: 5 } });
    // Windows has no POSIX permission bits; stat reports 0o666 there.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new McpOAuthStore(file).get("docs", URL_A)).toEqual({ url: URL_A, state: "signed-in", clientId: "c1", tokens: { access: "at", refresh: "rt", expiresAt: 5 } });
  });

  it("does not hand a record to a different URL", () => {
    const store = new McpOAuthStore(file);
    store.put("docs", { url: URL_A, state: "signed-in", tokens: { access: "at" } });
    expect(store.get("docs", "https://evil.example.com/mcp")).toBeUndefined();
  });

  it("deletes a record", () => {
    const store = new McpOAuthStore(file);
    store.put("docs", { url: URL_A, state: "needs-sign-in" });
    store.delete("docs");
    expect(store.get("docs", URL_A)).toBeUndefined();
  });

  it("reads a corrupt file as empty and leaves it until the next write", () => {
    writeFileSync(file, "{not json", { mode: 0o600 });
    const store = new McpOAuthStore(file);
    expect(store.get("docs", URL_A)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("{not json");
    store.put("docs", { url: URL_A, state: "needs-sign-in" });
    expect(store.get("docs", URL_A)?.state).toBe("needs-sign-in");
  });
});
