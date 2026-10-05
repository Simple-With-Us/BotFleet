// The plugin sandbox is a security boundary, so these tests run real
// child processes against small hostile plugins and assert what the
// plugin can and cannot reach.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHostSnapshot,
  invokePlugin,
  loadPlugin,
  type LoadedPlugin,
  type PluginHostInputs,
  type PluginLogEvent,
} from "./plugin-loader.ts";
import { PluginCardResultSchema } from "./plugin-sandbox-protocol.ts";
import { removeDirSafe } from "./plugin-registry.ts";
import type { PluginListing } from "./plugin-types.ts";

const SECRET_ENV = "BOTFLEET_SANDBOX_TEST_SECRET";
const SECRET_VALUE = "sk-sandbox-test-0123456789";

let baseDir: string;
let outsideDir: string;
let events: PluginLogEvent[];
const started: LoadedPlugin[] = [];

function inputs(): PluginHostInputs {
  return {
    listBots: () => [{ id: "a", name: "Alpha", status: "running", driver: "claude" }],
    listConfigKeys: () => ["appearance", "providerApiKey"],
    readConfig: <T = unknown>(key: string): T | undefined => {
      if (key === "appearance") {
        // SAFETY: test stub; the caller names T and the sandbox only forwards redacted JSON.
        return { theme: "dark", accessToken: SECRET_VALUE } as T;
      }
      if (key === "providerApiKey") {
        // SAFETY: test stub returning a secret the host must never forward.
        return SECRET_VALUE as T;
      }
      return undefined;
    },
    logger: (event) => events.push(event),
  };
}

function listing(name: string, capabilities: string[] = ["read.bots", "read.status"]): PluginListing {
  return {
    name,
    version: "1.0.0",
    description: "sandbox test plugin",
    botfleet: ">=1",
    entry: "plugin.mjs",
    enabled: true,
    installedAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    source: { kind: "folder", path: "<test>" },
    warnings: [],
    capabilities,
  };
}

function writePlugin(name: string, source: string): void {
  mkdirSync(join(baseDir, name), { recursive: true });
  writeFileSync(join(baseDir, name, "plugin.mjs"), source);
}

async function load(name: string, capabilities?: string[], callTimeoutMs?: number): Promise<LoadedPlugin> {
  const result = await loadPlugin(listing(name, capabilities), inputs(), baseDir, { callTimeoutMs });
  if ("error" in result) throw new Error(result.error);
  started.push(result);
  return result;
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "botfleet-sandbox-"));
  outsideDir = mkdtempSync(join(tmpdir(), "botfleet-sandbox-outside-"));
  writeFileSync(join(outsideDir, "secret.txt"), SECRET_VALUE);
  events = [];
  process.env[SECRET_ENV] = SECRET_VALUE;
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((plugin) => plugin.sandbox.dispose()));
  delete process.env[SECRET_ENV];
  removeDirSafe(baseDir);
  removeDirSafe(outsideDir);
});

describe("plugin sandbox isolation", () => {
  it("runs handlers out of process and answers host calls from the snapshot", async () => {
    writePlugin("ok", `
      export function getCardData({ host }) { return { result: { bots: host.getBots().length, pid: process.pid } }; }
      export function runCommand({ args }) { return "echo:" + args; }
    `);
    const plugin = await load("ok");
    expect(plugin.sandbox.exports).toEqual({ getCardData: true, runCommand: true });
    const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
    if (!card.ok) throw new Error(card.reason);
    const parsed = PluginCardResultSchema.parse(card.value);
    expect(parsed.result).toMatchObject({ bots: 1 });
    expect(parsed.result).not.toMatchObject({ pid: process.pid });
    const command = await invokePlugin(plugin, { handler: "runCommand", command: "c", args: "hi" }, inputs());
    expect(command).toEqual({ ok: true, value: "echo:hi" });
  });

  it("does not expose the server's environment", async () => {
    writePlugin("env", `
      export function getCardData() {
        return { result: { secret: process.env.${SECRET_ENV} ?? null, keys: Object.keys(process.env) } };
      }
    `);
    const plugin = await load("env");
    const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
    if (!card.ok) throw new Error(card.reason);
    expect(JSON.stringify(card.value)).not.toContain(SECRET_VALUE);
    const { result } = PluginCardResultSchema.parse(card.value);
    expect(result).toMatchObject({ secret: null });
  });

  it("denies filesystem reads outside the plugin folder, writes, and subprocesses", async () => {
    const outside = JSON.stringify(join(outsideDir, "secret.txt"));
    writePlugin("fs", `
      import fs from "node:fs";
      import cp from "node:child_process";
      const attempt = (fn) => { try { fn(); return "allowed"; } catch (error) { return error.code ?? "error"; } };
      export function getCardData() {
        return { result: {
          readOutside: attempt(() => fs.readFileSync(${outside}, "utf8")),
          readOwn: attempt(() => fs.readFileSync(new URL("./plugin.mjs", import.meta.url), "utf8")),
          write: attempt(() => fs.writeFileSync(new URL("./dropped.txt", import.meta.url), "x")),
          spawn: attempt(() => cp.execFileSync("true")),
        } };
      }
    `);
    const plugin = await load("fs");
    const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
    if (!card.ok) throw new Error(card.reason);
    const { result } = PluginCardResultSchema.parse(card.value);
    expect(result).toEqual({
      readOutside: "ERR_ACCESS_DENIED",
      readOwn: "allowed",
      write: "ERR_ACCESS_DENIED",
      spawn: "ERR_ACCESS_DENIED",
    });
    expect(readdirSync(join(baseDir, "fs"))).toEqual(["plugin.mjs"]);
  });

  it("rejects a module whose handler exports are not functions", async () => {
    writePlugin("bad-exports", `export const getCardData = 42;`);
    const result = await loadPlugin(listing("bad-exports"), inputs(), baseDir);
    expect(result).toEqual({ error: `plugin "bad-exports" failed to load (invalid_exports)` });
    expect(events).toContainEqual(expect.objectContaining({ event: "plugin.sandbox", reason: "invalid_exports" }));
  });

  it("reports an import failure without the raw error text", async () => {
    writePlugin("throws", `throw new Error("${SECRET_VALUE}");`);
    const result = await loadPlugin(listing("throws"), inputs(), baseDir);
    expect(result).toEqual({ error: `plugin "throws" failed to load (import_failed)` });
    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
  });

  it("kills a handler that overruns its deadline and fails the call", async () => {
    writePlugin("hang", `export function runCommand() { for (;;) {} }`);
    const plugin = await load("hang", undefined, 300);
    const result = await invokePlugin(plugin, { handler: "runCommand", command: "c", args: "" }, inputs());
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(plugin.sandbox.isAlive()).toBe(false);
  });

  it("kills the child on a message that fails the protocol schema", async () => {
    writePlugin("forger", `export function runCommand() { process.send({ type: "log", level: "info", message: "${SECRET_VALUE}" }); return new Promise(() => {}); }`);
    const plugin = await load("forger");
    const result = await invokePlugin(plugin, { handler: "runCommand", command: "c", args: "" }, inputs());
    expect(result).toEqual({ ok: false, reason: "sandbox_exited" });
    expect(plugin.sandbox.isAlive()).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ event: "plugin.sandbox", reason: "protocol_violation" }));
    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
  });

  it("never forwards plugin log text or thrown error text to the host logger", async () => {
    writePlugin("noisy", `
      export function getCardData({ host }) { host.log("error", "${SECRET_VALUE}"); return { result: null }; }
      export function runCommand() { throw new Error("${SECRET_VALUE}"); }
    `);
    const plugin = await load("noisy");
    await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
    const failed = await invokePlugin(plugin, { handler: "runCommand", command: "c", args: "" }, inputs());
    expect(failed).toEqual({ ok: false, reason: "handler_threw" });
    expect(events).toContainEqual(expect.objectContaining({ event: "plugin.log", level: "error", length: SECRET_VALUE.length }));
    expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(events)).not.toContain("noisy");
  });
});

describe("plugin host snapshot", () => {
  it("withholds undeclared capabilities and reports the refusal", async () => {
    writePlugin("nocaps", `
      export function getCardData({ host }) {
        return { result: { bots: host.getBots(), keys: host.config.listKeys(), theme: host.config.get("appearance") ?? null } };
      }
    `);
    const plugin = await load("nocaps", []);
    const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
    if (!card.ok) throw new Error(card.reason);
    expect(PluginCardResultSchema.parse(card.value).result).toEqual({ bots: [], keys: [], theme: null });
    expect(events).toContainEqual(expect.objectContaining({ event: "plugin.capability_refused", capability: "read.bots" }));
    expect(events).toContainEqual(expect.objectContaining({ event: "plugin.capability_refused", capability: "read.config" }));
  });

  it("forwards only redacted, non-secret config keys", () => {
    const snapshot = buildHostSnapshot(inputs(), ["read.config"]);
    expect(snapshot.configKeys).toEqual(["appearance"]);
    expect(snapshot.config).toEqual({ appearance: { theme: "dark" } });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_VALUE);
    expect(snapshot.bots).toBeNull();
  });

  it("blanks bot status without read.status", () => {
    const snapshot = buildHostSnapshot(inputs(), ["read.bots"]);
    expect(snapshot.bots).toEqual([{ id: "a", name: "Alpha", status: "", driver: "claude" }]);
    expect(snapshot.statusAllowed).toBe(false);
  });
});

describe("plugin result schemas", () => {
  it("rejects a card result that is not { result: <JSON> }", () => {
    expect(PluginCardResultSchema.safeParse("text").success).toBe(false);
    expect(PluginCardResultSchema.safeParse({ result: 1, extra: true }).success).toBe(false);
    expect(PluginCardResultSchema.safeParse({ result: { a: [1, null] } }).success).toBe(true);
  });
});
