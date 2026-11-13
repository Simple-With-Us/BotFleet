// The plugin sandbox is a security boundary, so these tests run real
// child processes against small hostile plugins and assert what the
// plugin can and cannot reach.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildHostSnapshot,
  invokePlugin,
  loadPlugin,
  type LoadedPlugin,
  type PluginHostInputs,
  type PluginLogEvent,
} from "./plugin-loader.ts";
import { PluginCardResultSchema } from "./plugin-sandbox-protocol.ts";
import type { PluginEventEnvelope } from "../shared/plugin-events.ts";
import { removeDirSafe } from "./plugin-registry.ts";
import type { PluginListing } from "./plugin-types.ts";

const SECRET_ENV = "BOTFLEET_SANDBOX_TEST_SECRET";
const SECRET_VALUE = "sandbox-sensitive-sentinel";

let baseDir: string;
let outsideDir: string;
let events: PluginLogEvent[];
const started: LoadedPlugin[] = [];

function inputs(): PluginHostInputs {
  return {
    listBots: () => [{ id: "a", name: "Alpha", status: "running", driver: "claude" }],
    listConfigKeys: () => ["rooms", "providerApiKey"],
    readConfig: (key: string) => {
      if (key === "rooms") {
        return { turnTimeoutMinutes: 30, accessToken: SECRET_VALUE };
      }
      if (key === "providerApiKey") {
        return SECRET_VALUE;
      }
      return undefined;
    },
    logger: (event) => events.push(event),
  };
}

function listing(
  name: string,
  capabilities: string[] = ["read.bots", "read.status"],
  needs?: PluginListing["needs"],
  sourcePath = "<test>",
): PluginListing {
  const base: PluginListing = {
    name,
    version: "1.0.0",
    description: "sandbox test plugin",
    botfleet: ">=1",
    entry: "plugin.mjs",
    enabled: true,
    installedAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
    source: { kind: "folder", path: sourcePath },
    warnings: [],
    capabilities,
  };
  if (needs) return { ...base, needs };
  return base;
}

function writePlugin(name: string, source: string): void {
  mkdirSync(join(baseDir, name), { recursive: true });
  writeFileSync(join(baseDir, name, "plugin.mjs"), source);
}

async function load(
  name: string,
  capabilities?: string[],
  callTimeoutMs?: number,
  needs?: PluginListing["needs"],
  extra?: { firstPartyRoot?: string; zulipRealm?: string; sourcePath?: string },
): Promise<LoadedPlugin> {
  const result = await loadPlugin(
    listing(name, capabilities, needs, extra?.sourcePath),
    inputs(),
    baseDir,
    { callTimeoutMs, firstPartyRoot: extra?.firstPartyRoot, zulipRealm: extra?.zulipRealm },
  );
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
  await removeDirSafe(baseDir);
  await removeDirSafe(outsideDir);
});

describe("plugin sandbox isolation", () => {
  it("runs handlers out of process and answers host calls from the snapshot", async () => {
    writePlugin("ok", `
      export function getCardData({ host }) { return { result: { bots: host.getBots().length, pid: process.pid } }; }
      export function runCommand({ args }) { return "echo:" + args; }
    `);
    const plugin = await load("ok");
    expect(plugin.sandbox.exports).toEqual({ getCardData: true, runCommand: true, onEvent: false, getHealth: false });
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

  it("loads when the plugin tree is reached through a symlink (macOS tmpdir)", async () => {
    // macOS CI puts mkdtemp under `/var/folders/...`, a symlink to
    // `/private/var/folders/...`.  Node's permission model matches the
    // real path; without canonicalizing the grant and the entry URL the
    // child reports import_failed.  Reproduce that shape on every OS.
    const realRoot = mkdtempSync(join(tmpdir(), "botfleet-sandbox-real-"));
    const linkRoot = join(mkdtempSync(join(tmpdir(), "botfleet-sandbox-link-")), "plugins");
    symlinkSync(realRoot, linkRoot, process.platform === "win32" ? "junction" : "dir");
    const previousBase = baseDir;
    baseDir = linkRoot;
    try {
      expect(baseDir).not.toBe(realpathSync(baseDir));
      writePlugin("symlink-ok", `
        export function getCardData() { return { result: { ok: true } }; }
      `);
      const plugin = await load("symlink-ok");
      const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
      expect(card).toEqual({ ok: true, value: { result: { ok: true } } });
    } finally {
      await Promise.all(started.splice(0).map((plugin) => plugin.sandbox.dispose()));
      baseDir = previousBase;
      await removeDirSafe(linkRoot);
      await removeDirSafe(dirname(linkRoot));
      await removeDirSafe(realRoot);
    }
  });
});

function tcpListenPort(address: ReturnType<Server["address"]>): number {
  if (address === null) throw new Error("test server has no port");
  if (Object.prototype.toString.call(address) === "[object String]") {
    throw new Error("test server has no port");
  }
  // SAFETY: listen(0, "127.0.0.1") returns AddressInfo.  A string address is a Unix pipe name, which this helper does not open.
  return (address as AddressInfo).port;
}

async function listenLocal(onHit: () => void): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    onHit();
    res.end("yes");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return { server, port: tcpListenPort(server.address()) };
}

describe("plugin sandbox egress", () => {
  it("blocks outbound connect, fetch, udp, dns, and raw tcp bindings", async () => {
    let hits = 0;
    const local = await listenLocal(() => {
      hits += 1;
    });
    try {
      const url = JSON.stringify(`http://127.0.0.1:${local.port}/`);
      writePlugin("egress", `
        import net from "node:net";
        import dgram from "node:dgram";
        import dns from "node:dns/promises";
        function tcp(host, port) {
          return new Promise((resolve) => {
            let socket;
            try {
              socket = net.connect({ host, port, timeout: 500 });
            } catch (error) {
              resolve(error.code || "error");
              return;
            }
            const finish = (value) => { socket.destroy(); resolve(value); };
            socket.on("connect", () => finish("connected"));
            socket.on("error", (error) => finish(error.code || "error"));
            socket.setTimeout(500, () => finish("timeout"));
          });
        }
        export async function getCardData() {
          let binding = "open";
          try { process.binding("tcp_wrap"); }
          catch (error) { binding = error.code || "error"; }
          let udp = "open";
          try {
            const sock = dgram.createSocket("udp4");
            udp = await new Promise((resolve) => {
              try {
                sock.send(Buffer.from("x"), 53, "1.1.1.1", (error) => {
                  sock.close();
                  resolve(error ? (error.code || "error") : "sent");
                });
              } catch (error) {
                sock.close();
                resolve(error.code || "error");
              }
            });
          } catch (error) {
            udp = error.code || "error";
          }
          let looked = "open";
          try { await dns.lookup("example.com"); }
          catch (error) { looked = error.code || "error"; }
          let fetched = "open";
          try {
            const response = await fetch(${url}, { signal: AbortSignal.timeout(800) });
            fetched = "status " + response.status;
          } catch (error) {
            fetched = (error.cause && error.cause.code) || error.code || error.name || "error";
          }
          return { result: {
            binding,
            udp,
            looked,
            fetched,
            local: await tcp("127.0.0.1", ${local.port}),
            remote: await tcp("203.0.113.1", 80),
          } };
        }
      `);
      const plugin = await load("egress", []);
      const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
      if (!card.ok) throw new Error(card.reason);
      expect(PluginCardResultSchema.parse(card.value).result).toEqual({
        binding: "ERR_ACCESS_DENIED",
        udp: "ERR_ACCESS_DENIED",
        looked: "ERR_ACCESS_DENIED",
        fetched: "ERR_ACCESS_DENIED",
        local: "ERR_ACCESS_DENIED",
        remote: "ERR_ACCESS_DENIED",
      });
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => local.server.close(resolve));
    }
  });

  it("does not let plugin code widen an empty allowlist", async () => {
    let hits = 0;
    const local = await listenLocal(() => {
      hits += 1;
    });
    try {
      writePlugin("widen", `
        import net from "node:net";
        process.emit("message", {
          type: "load",
          entryUrl: import.meta.url,
          networkAllow: ["127.0.0.1:${local.port}"],
        });
        export async function getCardData() {
          return await new Promise((resolve) => {
            let socket;
            try {
              socket = net.connect({ host: "127.0.0.1", port: ${local.port}, timeout: 500 });
            } catch (error) {
              resolve({ result: { local: error.code || "error" } });
              return;
            }
            const finish = (local) => { socket.destroy(); resolve({ result: { local } }); };
            socket.on("connect", () => finish("connected"));
            socket.on("error", (error) => finish(error.code || "error"));
            socket.setTimeout(500, () => finish("timeout"));
          });
        }
      `);
      const plugin = await load("widen", []);
      const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
      if (!card.ok) throw new Error(card.reason);
      expect(PluginCardResultSchema.parse(card.value).result).toEqual({ local: "ERR_ACCESS_DENIED" });
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => local.server.close(resolve));
    }
  });

  it("allows only the declared host and port", async () => {
    let allowedHits = 0;
    let blockedHits = 0;
    const allowed = await listenLocal(() => {
      allowedHits += 1;
    });
    const blocked = await listenLocal(() => {
      blockedHits += 1;
    });
    try {
      const url = JSON.stringify(`http://127.0.0.1:${allowed.port}/`);
      writePlugin("allow", `
        import net from "node:net";
        function tcp(port) {
          return new Promise((resolve) => {
            let socket;
            try {
              socket = net.connect({ host: "127.0.0.1", port, timeout: 500 });
            } catch (error) {
              resolve(error.code || "error");
              return;
            }
            const finish = (value) => { socket.destroy(); resolve(value); };
            socket.on("connect", () => finish("connected"));
            socket.on("error", (error) => finish(error.code || "error"));
            socket.setTimeout(500, () => finish("timeout"));
          });
        }
        export async function getCardData() {
          let binding = "open";
          try { process.binding("udp_wrap"); }
          catch (error) { binding = error.code || "error"; }
          let body = "";
          try {
            const response = await fetch(${url});
            body = await response.text();
          } catch (error) {
            body = error.code || "error";
          }
          return { result: {
            binding,
            body,
            allowed: await tcp(${allowed.port}),
            blocked: await tcp(${blocked.port}),
          } };
        }
      `);
      const plugin = await load("allow", ["net.hosts"], undefined, { network: [`127.0.0.1:${allowed.port}`] });
      const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
      if (!card.ok) throw new Error(card.reason);
      expect(PluginCardResultSchema.parse(card.value).result).toEqual({
        binding: "ERR_ACCESS_DENIED",
        body: "yes",
        allowed: "connected",
        blocked: "ERR_ACCESS_DENIED",
      });
      expect(allowedHits).toBeGreaterThan(0);
      expect(blockedHits).toBe(0);
    } finally {
      await new Promise((resolve) => allowed.server.close(resolve));
      await new Promise((resolve) => blocked.server.close(resolve));
    }
  });

  it("does not let a connect getter change the destination after the check", async () => {
    let allowedConns = 0;
    let blockedConns = 0;
    const allowed = await listenLocal(() => {});
    const blocked = await listenLocal(() => {});
    allowed.server.on("connection", () => {
      allowedConns += 1;
    });
    blocked.server.on("connection", () => {
      blockedConns += 1;
    });
    try {
      writePlugin("getter-connect", `
        import net from "node:net";
        export function getCardData() {
          let hostReads = 0;
          let portReads = 0;
          const options = {};
          Object.defineProperty(options, "host", {
            enumerable: true,
            get() {
              hostReads += 1;
              return hostReads === 1 ? "127.0.0.1" : "203.0.113.9";
            },
          });
          Object.defineProperty(options, "port", {
            enumerable: true,
            get() {
              portReads += 1;
              return portReads === 1 ? ${allowed.port} : ${blocked.port};
            },
          });
          return new Promise((resolve) => {
            let socket;
            try {
              socket = new net.Socket();
              socket.connect(options);
            } catch (error) {
              resolve({ result: { local: error.code || "error" } });
              return;
            }
            const finish = (value) => {
              socket.destroy();
              resolve({ result: { local: value } });
            };
            socket.on("connect", () => finish("connected"));
            socket.on("error", (error) => finish(error.code || "error"));
            socket.setTimeout(500, () => finish("timeout"));
          });
        }
      `);
      const plugin = await load("getter-connect", ["net.hosts"], undefined, { network: [`127.0.0.1:${allowed.port}`] });
      const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
      if (!card.ok) throw new Error(card.reason);
      expect(PluginCardResultSchema.parse(card.value).result).toEqual({ local: "connected" });
      expect(allowedConns).toBeGreaterThan(0);
      expect(blockedConns).toBe(0);
    } finally {
      await new Promise((resolve) => allowed.server.close(resolve));
      await new Promise((resolve) => blocked.server.close(resolve));
    }
  });

  it("drops an invalid needs entry instead of granting it", async () => {
    let hits = 0;
    const local = await listenLocal(() => {
      hits += 1;
    });
    try {
      writePlugin("bogus-needs", `
        import net from "node:net";
        export function getCardData() {
          try {
            net.connect({ host: "127.0.0.1", port: ${local.port} });
            return { result: { local: "started" } };
          } catch (error) {
            return { result: { local: error.code || "error" } };
          }
        }
      `);
      const plugin = await load("bogus-needs", ["net.hosts"], undefined, { network: ["*", "https://evil.test/x"] });
      const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
      if (!card.ok) throw new Error(card.reason);
      expect(PluginCardResultSchema.parse(card.value).result).toEqual({ local: "ERR_ACCESS_DENIED" });
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => local.server.close(resolve));
    }
  });

  it("ignores a declared host list when net.hosts is absent", async () => {
    let hits = 0;
    const local = await listenLocal(() => {
      hits += 1;
    });
    try {
      writePlugin("undeclared-cap", `
        import net from "node:net";
        export function getCardData() {
          try {
            net.connect({ host: "127.0.0.1", port: ${local.port} });
            return { result: { local: "started" } };
          } catch (error) {
            return { result: { local: error.code || "error" } };
          }
        }
      `);
      const plugin = await load("undeclared-cap", ["read.bots"], undefined, { network: [`127.0.0.1:${local.port}`] });
      const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
      if (!card.ok) throw new Error(card.reason);
      expect(PluginCardResultSchema.parse(card.value).result).toEqual({ local: "ERR_ACCESS_DENIED" });
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => local.server.close(resolve));
    }
  });

  it("allows the shipped Zulip plugin to reach the configured realm host", async () => {
    let realmHits = 0;
    let otherHits = 0;
    const realm = await listenLocal(() => {
      realmHits += 1;
    });
    const other = await listenLocal(() => {
      otherHits += 1;
    });
    const shippedRoot = mkdtempSync(join(tmpdir(), "botfleet-shipped-zulip-"));
    mkdirSync(join(shippedRoot, "zulip"));
    try {
      const realmUrl = JSON.stringify(`http://127.0.0.1:${realm.port}/`);
      writePlugin("zulip", `
        import net from "node:net";
        export async function getCardData() {
          let body = "";
          try {
            const response = await fetch(${realmUrl});
            body = await response.text();
          } catch (error) {
            body = error.code || "error";
          }
          const other = await new Promise((resolve) => {
            let socket;
            try {
              socket = net.connect({ host: "127.0.0.1", port: ${other.port}, timeout: 500 });
            } catch (error) {
              resolve(error.code || "error");
              return;
            }
            const finish = (value) => { socket.destroy(); resolve(value); };
            socket.on("connect", () => finish("connected"));
            socket.on("error", (error) => finish(error.code || "error"));
            socket.setTimeout(500, () => finish("timeout"));
          });
          return { result: { body, other } };
        }
      `);
      const plugin = await load("zulip", [], undefined, undefined, {
        firstPartyRoot: shippedRoot,
        sourcePath: join(shippedRoot, "zulip"),
        zulipRealm: `http://127.0.0.1:${realm.port}`,
      });
      const card = await invokePlugin(plugin, { handler: "getCardData", cardId: "x" }, inputs());
      if (!card.ok) throw new Error(card.reason);
      expect(PluginCardResultSchema.parse(card.value).result).toEqual({
        body: "yes",
        other: "ERR_ACCESS_DENIED",
      });
      expect(realmHits).toBeGreaterThan(0);
      expect(otherHits).toBe(0);
    } finally {
      await new Promise((resolve) => realm.server.close(resolve));
      await new Promise((resolve) => other.server.close(resolve));
      await removeDirSafe(shippedRoot);
    }
  });
});

describe("plugin host snapshot", () => {
  it("withholds undeclared capabilities and reports the refusal", async () => {
    writePlugin("nocaps", `
      export function getCardData({ host }) {
        return { result: { bots: host.getBots(), keys: host.config.listKeys(), theme: host.config.get("rooms") ?? null } };
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
    expect(snapshot.configKeys).toEqual(["rooms"]);
    expect(snapshot.config).toEqual({ rooms: { turnTimeoutMinutes: 30 } });
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

describe("plugin sandbox event delivery", () => {
  const EVENT: PluginEventEnvelope = {
    eventId: "zulip:BF-Plumber:42",
    type: "zulip.message",
    source: { platform: "zulip", accountId: "BF-Plumber" },
    occurredAt: "2026-10-15T12:00:00.000Z",
    receivedAt: "2026-10-15T12:00:01.000Z",
    refs: { messageId: 42, conversationKey: "dm:7" },
    mentions: [],
    context: { botId: "bot-plumber", wakeReason: "dm", senderKind: "owner" },
  };

  it("delivers events to onEvent and validates the routing decision", async () => {
    writePlugin("events", `
      export function onEvent({ event, host }) {
        host.log("info", "saw " + event.eventId);
        return { action: "requestWake", targetBotId: "bot-director", rationale: "owner DM" };
      }
      export function getHealth() { return { status: "ok", detail: "ready" }; }
    `);
    const plugin = await load("events", ["events.subscribe", "dispatch.wake"]);
    expect(plugin.sandbox.exports.onEvent).toBe(true);
    expect(plugin.sandbox.exports.getHealth).toBe(true);
    const { invokePluginEvent, fetchPluginHealth } = await import("./plugin-loader.ts");
    const { PluginEventDecisionSchema, PluginHealthResultSchema } = await import("./plugin-sandbox-protocol.ts");
    const delivered = await invokePluginEvent(plugin, EVENT, inputs());
    if (!delivered.ok) throw new Error(delivered.reason);
    const decision = PluginEventDecisionSchema.safeParse(delivered.value);
    expect(decision.success).toBe(true);
    const health = await fetchPluginHealth(plugin, inputs());
    if (!health.ok) throw new Error(health.reason);
    expect(PluginHealthResultSchema.safeParse(health.value).success).toBe(true);
    // Log text stays in the child; the parent sees level and length only.
    expect(events.some((e) => e.event === "plugin.log" && e.level === "info")).toBe(true);
    expect(JSON.stringify(events).includes("saw zulip")).toBe(false);
  });

  it("reports not_implemented when onEvent is absent", async () => {
    writePlugin("noevents", `
      export function runCommand() { return "hi"; }
    `);
    const plugin = await load("noevents", ["events.subscribe"]);
    expect(plugin.sandbox.exports.onEvent).toBe(false);
    const { invokePluginEvent } = await import("./plugin-loader.ts");
    const delivered = await invokePluginEvent(plugin, EVENT, inputs());
    expect(delivered.ok).toBe(false);
    if (delivered.ok) return;
    expect(delivered.reason).toBe("not_implemented");
  });

  it("kills a hanging onEvent on the call deadline without killing the host", async () => {
    writePlugin("hang", `
      export async function onEvent() { await new Promise(() => {}); }
    `);
    const plugin = await load("hang", ["events.subscribe"], 200);
    const { invokePluginEvent } = await import("./plugin-loader.ts");
    const delivered = await invokePluginEvent(plugin, EVENT, inputs());
    expect(delivered.ok).toBe(false);
    if (delivered.ok) return;
    expect(delivered.reason).toBe("timeout");
    expect(plugin.sandbox.isAlive()).toBe(false);
  });
});
