import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { supportsDirectoryFsync, ZulipOutgoingSpool } from "./outgoing-spool.ts";
import { createZulipOutgoingWebhookRoute, type OutgoingWebhookHub } from "./webhook.ts";

const dirs: string[] = [];
const servers: Server[] = [];
function portOf(address: AddressInfo | string | null): number {
  const parsed = z.object({ port: z.number() }).passthrough().safeParse(address);
  if (!parsed.success) throw new Error("missing test server address");
  return parsed.data.port;
}

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "bf-zulip-outgoing-"));
  dirs.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Zulip outgoing webhook spool", () => {
  it("skips unsupported directory fsync on Windows", () => {
    expect(supportsDirectoryFsync("win32")).toBe(false);
    expect(supportsDirectoryFsync("darwin")).toBe(true);
    expect(supportsDirectoryFsync("linux")).toBe(true);
  });

  it("survives reconstruction, deduplicates valid rows, and repairs torn rows before ack", () => {
    const dir = tempDir();
    const spool = new ZulipOutgoingSpool(dir);
    expect(spool.add("bot-1", 17)).toBe(true);
    expect(spool.add("bot-1", 17)).toBe(false);
    const restarted = new ZulipOutgoingSpool(dir);
    expect(restarted.pending()).toEqual([{ botId: "bot-1", messageId: 17 }]);

    const path = join(restarted.directory, "bot-1-18.json");
    writeFileSync(path, "{torn", { mode: 0o600 });
    expect(restarted.add("bot-1", 18)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ botId: "bot-1", messageId: 18 });
    expect(restarted.pending()).toHaveLength(2);
  });

  it("scans the directory once for a burst of adds and invalidates the count after removal", () => {
    const dir = tempDir();
    let scans = 0;
    const spool = new ZulipOutgoingSpool(dir, (path) => {
      scans += 1;
      return readdirSync(path);
    });
    expect(spool.add("bot-1", 17)).toBe(true);
    expect(spool.add("bot-1", 18)).toBe(true);
    expect(spool.add("bot-1", 19)).toBe(true);
    expect(scans).toBe(1);

    spool.remove({ botId: "bot-1", messageId: 18 });
    expect(spool.add("bot-1", 20)).toBe(true);
    expect(scans).toBe(2);
  });
});

describe("Zulip outgoing webhook receiver", () => {
  it("authenticates seat and bot email, ignores supplied message content, and acknowledges replay", async () => {
    const accepted: Array<{ role: string; id: number }> = [];
    const fake = {
      outgoingWebhookAvailability: (role: string) => role.toUpperCase() === "BF-PLUMBER" ? "ready" : "unknown",
      authorizeOutgoingWebhook: (role: string, email: string, token: string) =>
        role.toUpperCase() !== "BF-PLUMBER" ? "unknown" : email === "plumber@zulip.test" && token === "secret-token" ? "ok" : "unauthorized",
      enqueueOutgoingWebhook: (role: string, id: number) => {
        accepted.push({ role, id });
        return accepted.length === 1 ? "accepted" : "duplicate";
      },
    } satisfies OutgoingWebhookHub;
    const route = createZulipOutgoingWebhookRoute(() => fake, () => () => {});
    const server = createServer((req, res) => void route.handler(req, res));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = portOf(server.address());
    const url = `http://127.0.0.1:${port}/zulip/outgoing/BF-PLUMBER`;
    const payload = {
      token: "secret-token",
      bot_email: "plumber@zulip.test",
      trigger: "mention",
      message: { id: 42, content: "untrusted webhook text must not be routed" },
    };
    const send = (body: typeof payload) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    expect((await send({ ...payload, token: "wrong" })).status).toBe(401);
    expect((await send({ ...payload, bot_email: "other@zulip.test" })).status).toBe(401);
    expect((await fetch(url.replace("BF-PLUMBER", "BF-UNKNOWN"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    })).status).toBe(404);
    const first = await send(payload);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ response_not_required: true });
    expect((await send(payload)).status).toBe(200);
    expect(accepted).toEqual([{ role: "BF-PLUMBER", id: 42 }, { role: "BF-PLUMBER", id: 42 }]);
  });

  it("rejects malformed and oversized bodies without admission", async () => {
    let admissions = 0;
    const fake = {
      outgoingWebhookAvailability: () => "ready",
      authorizeOutgoingWebhook: () => "ok",
      enqueueOutgoingWebhook: () => "accepted",
    } satisfies OutgoingWebhookHub;
    const route = createZulipOutgoingWebhookRoute(() => fake, () => { admissions += 1; return () => {}; });
    const server = createServer((req, res) => void route.handler(req, res));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = portOf(server.address());
    const url = `http://127.0.0.1:${port}/zulip/outgoing/BF-PLUMBER`;
    const malformed = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    const large = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(129 * 1024),
    });
    expect(large.status).toBe(413);
    expect((await fetch(url.replace("BF-PLUMBER", "BF-Plumber"), {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(404);
    expect((await fetch(`${url}?ignored=1`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(404);
    expect(admissions).toBe(0);
  });

  it("times out a body that stops arriving", async () => {
    const fake = {
      outgoingWebhookAvailability: () => "ready",
      authorizeOutgoingWebhook: () => "ok",
      enqueueOutgoingWebhook: () => "accepted",
    } satisfies OutgoingWebhookHub;
    const route = createZulipOutgoingWebhookRoute(() => fake, () => () => {});
    const server = createServer((req, res) => void route.handler(req, res));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = portOf(server.address());
    const response = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/zulip/outgoing/BF-PLUMBER", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => { req.destroy(); resolve(res.statusCode ?? 0); });
      });
      req.on("error", reject);
      req.flushHeaders();
      req.write("{");
    });
    expect(response).toBe(408);
  });
});
