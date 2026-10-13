// The Zulip tools on both lanes: offered only when the dispatch says the
// bot's Zulip identity is connected, and always called with the TURN's
// identity — never one the model put in the arguments.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTurnToolHost } from "../tools/host.ts";
import { httpToolDefinitions, mcpToolDefinitions, toolsFor } from "../tools/registry.ts";
import type { ZulipToolRequest } from "../tools/zulip.ts";
import { buildTurnTools } from "../turn-tools.ts";

const gate = { agents: true, commsDepth: 0, maxCommsDepth: 1, chiefOfStaff: false };

describe("the registry", () => {
  it("offers zulip_reply, zulip_post and zulip_follow_topic on both lanes only when zulip is on", () => {
    for (const surface of ["mcp", "http"] as const) {
      expect(toolsFor(surface, gate).map((t) => t.name)).not.toContain("zulip_reply");
      expect(toolsFor(surface, { ...gate, zulip: true }).map((t) => t.name)).toEqual(
        expect.arrayContaining(["zulip_reply", "zulip_post", "zulip_follow_topic"]),
      );
    }
    // independent of peer comms: posting as yourself is not a hop
    expect(httpToolDefinitions({ ...gate, agents: false, zulip: true }).map((t) => t.name)).toEqual([
      "zulip_reply",
      "zulip_post",
      "zulip_follow_topic",
    ]);
    expect(mcpToolDefinitions({ ...gate, zulip: true }).map((t) => t.name).slice(-3)).toEqual([
      "zulip_reply",
      "zulip_post",
      "zulip_follow_topic",
    ]);
  });

  it("follows the dispatch's flag through buildTurnTools", () => {
    expect(buildTurnTools({ zulip: true }).map((t) => t.name)).toEqual(["zulip_reply", "zulip_post", "zulip_follow_topic"]);
    expect(buildTurnTools({ zulip: false }).map((t) => t.name)).toEqual([]);
  });
});

describe("the HTTP tool host", () => {
  // SAFETY: the Zulip tools never reach the peer-comms deps, so an empty set
  // stands in for the endpoint bodies these tests do not exercise.
  const deps = {} as Parameters<typeof createTurnToolHost>[0]["deps"];
  const runtime: Parameters<ReturnType<typeof createTurnToolHost>["execute"]>[1] = {
    requestApproval: async () => "allowed-once",
    signal: new AbortController().signal,
  };

  it("posts with the turn's identity, whatever the arguments claim", async () => {
    const seen: ZulipToolRequest[] = [];
    const host = createTurnToolHost({
      botId: "bot-plumber",
      threadId: "thread-1",
      commsDepth: 0,
      deps,
      zulip: {
        send: async (request) => {
          seen.push(request);
          return { ok: true, text: "Posted." };
        },
      },
    });
    const outcome = await host.execute(
      { id: "c1", name: "zulip_reply", arguments: { content: "hi", botId: "bot-other", threadId: "thread-other" } },
      runtime,
    );
    expect(outcome).toMatchObject({ kind: "result", content: "Posted." });
    expect(seen[0]).toMatchObject({ botId: "bot-plumber", threadId: "thread-1", tool: "reply" });
  });

  it("changes a follow with the turn's identity, and reads it back as a change, not a post", async () => {
    const seen: ZulipToolRequest[] = [];
    const host = createTurnToolHost({
      botId: "bot-plumber",
      threadId: "thread-1",
      commsDepth: 0,
      deps,
      zulip: {
        send: async (request) => {
          seen.push(request);
          return { ok: true, text: "Following #agent-sync > BF watch." };
        },
      },
    });
    const outcome = await host.execute(
      { id: "c1", name: "zulip_follow_topic", arguments: { channel: "agent-sync", topic: "BF watch", follow: true, botId: "bot-other" } },
      runtime,
    );
    expect(outcome).toMatchObject({ kind: "result", detail: "changed" });
    expect(seen[0]).toMatchObject({ botId: "bot-plumber", threadId: "thread-1", tool: "follow" });
  });

  it("reads a refusal back to the model as an error", async () => {
    const host = createTurnToolHost({
      botId: "bot-plumber",
      threadId: "thread-1",
      commsDepth: 0,
      deps,
      zulip: { send: async () => ({ ok: false, text: "Not posted: no." }) },
    });
    const outcome = await host.execute({ id: "c1", name: "zulip_post", arguments: { content: "x" } }, runtime);
    expect(outcome).toMatchObject({ kind: "error", content: "Not posted: no." });
  });

  it("has no Zulip executor when the dispatch did not mount it", async () => {
    const host = createTurnToolHost({ botId: "bot-plumber", threadId: "thread-1", commsDepth: 0, deps });
    const outcome = await host.execute({ id: "c1", name: "zulip_reply", arguments: { content: "x" } }, runtime);
    expect(outcome).toMatchObject({ kind: "error", detail: "unknown tool" });
  });
});

// The MCP lane: the real agents-proxy child against a stub harness.
const PROXY = join(dirname(fileURLToPath(import.meta.url)), "..", "drivers", "agents-proxy.ts");
const TOKEN = "zulip-test-comms-token";

describe("the MCP lane (agents-proxy)", () => {
  let stub: Server;
  let child: ChildProcess;
  let lastPath = "";
  let lastBody: unknown;
  let lastAuth: string | undefined;
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;

  const rpc = (method: string, params?: Record<string, string | Record<string, string | boolean>>): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => pending.delete(id) && reject(new Error(`${method} timed out`)), 10_000).unref?.();
    });

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        lastPath = req.url ?? "";
        lastAuth = req.headers.authorization;
        lastBody = data ? JSON.parse(data) : undefined;
        res.writeHead(200, { "content-type": "application/json" });
        const refused = data.includes('"refuse me"');
        res.end(JSON.stringify(refused ? { text: "Not posted: refused.", isError: true } : { text: "Posted to #x > y." }));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP host:port reports an AddressInfo.
    const port = (stub.address() as { port: number }).port;
    child = spawn(process.execPath, [PROXY], {
      env: {
        ...process.env,
        OMB_HARNESS_URL: `http://127.0.0.1:${port}`,
        OMB_BOT_ID: "bot-plumber",
        OMB_THREAD_ID: "thread-1",
        OMB_COMMS_TOKEN: TOKEN,
        OMB_TURN_DEPTH: "0",
        OMB_ZULIP: "1",
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buf = "";
    child.stdout!.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      }
    });
  });

  afterAll(async () => {
    child?.kill();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  it("publishes the Zulip tools last when OMB_ZULIP=1", async () => {
    await rpc("initialize", { protocolVersion: "2024-11-05" });
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name).slice(-3)).toEqual([
      "zulip_reply",
      "zulip_post",
      "zulip_follow_topic",
    ]);
  });

  it("hops to the harness with the turn's token and nothing else to identify it", async () => {
    const reply = await rpc("tools/call", { name: "zulip_reply", arguments: { content: "Tunnel is up." } });
    expect(lastPath).toBe("/api/internal/zulip/reply");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastBody).toEqual({ content: "Tunnel is up." });
    expect(reply.result).toMatchObject({ isError: false, content: [{ type: "text", text: "Posted to #x > y." }] });
    const refused = await rpc("tools/call", { name: "zulip_post", arguments: { channel: "c", topic: "t", content: "refuse me" } });
    expect(lastPath).toBe("/api/internal/zulip/post");
    expect(refused.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Not posted: refused." }] });
    await rpc("tools/call", { name: "zulip_follow_topic", arguments: { channel: "c", topic: "t", follow: true } });
    expect(lastPath).toBe("/api/internal/zulip/follow");
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(lastBody).toEqual({ channel: "c", topic: "t", follow: true });
  });
});
