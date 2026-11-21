// The named-tunnel webhook proxy, pinned end to end (BF-2129):
//
//   1. Path classification — only POST /hooks/* and POST /zulip/outgoing/*
//      qualify; nothing else the tunnel carries may be proxied.
//   2. Streaming — a delivery is piped to the loopback webhook ingress
//      untouched, and the ingress's answer comes back byte for byte.
//   3. Trust boundary, against a real booted harness — POST /hooks via the
//      tunnel reaches the ingress (which still refuses a bad secret), a
//      mutating /api/* call via the tunnel is still refused, and a loopback
//      caller without edge markers is unaffected.

import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isTunnelWebhookPath, proxyTunnelWebhook } from "./hooks-tunnel-proxy.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

describe("isTunnelWebhookPath", () => {
  it("matches POST capability and Zulip outgoing paths only", () => {
    expect(isTunnelWebhookPath("POST", "/hooks/wh_abc123")).toBe(true);
    expect(isTunnelWebhookPath("POST", "/hooks/wh_abc123/s3cr3t-token")).toBe(true);
    expect(isTunnelWebhookPath("POST", "/zulip/outgoing/WISE")).toBe(true);
    // Reads never proxy: the ingress answers 405 to them, and keeping them
    // out here leaves read probes off the tunnel surface entirely.
    expect(isTunnelWebhookPath("GET", "/hooks/wh_abc123/s3cr3t-token")).toBe(false);
    expect(isTunnelWebhookPath("GET", "/health")).toBe(false);
    // Nothing else the tunnel carries may be proxied.
    expect(isTunnelWebhookPath("POST", "/api/bots")).toBe(false);
    expect(isTunnelWebhookPath("POST", "/api/config")).toBe(false);
    expect(isTunnelWebhookPath("POST", "/hooks")).toBe(false);
    expect(isTunnelWebhookPath("POST", "/hooks/not-a-webhook-id/secret")).toBe(false);
    expect(isTunnelWebhookPath("POST", "/hooks/wh_abc/secret/extra")).toBe(false);
    expect(isTunnelWebhookPath("POST", "/zulip/outgoing/")).toBe(false);
    expect(isTunnelWebhookPath("POST", "/zulip/other/WISE")).toBe(false);
  });
});

type SeenDelivery = { method?: string; url?: string; body: Buffer; headers: IncomingMessage["headers"] };

describe("proxyTunnelWebhook", () => {
  let upstream: Server;
  let upstreamPort: number;
  let front: Server;
  let frontPort: number;
  let seen: SeenDelivery;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen = { method: req.method, url: req.url, body: Buffer.concat(chunks), headers: req.headers };
        res.writeHead(202, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ accepted: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    // SAFETY: `listen` has resolved, so the server is bound and `address()`
    // is an `AddressInfo` carrying the port it was given.
    upstreamPort = (upstream.address() as AddressInfo).port;
    front = createServer((req, res) => {
      void proxyTunnelWebhook(req, res, { port: upstreamPort }).catch((error: unknown) => {
        console.warn("test proxy failure:", error instanceof Error ? error.message : "unknown error");
      });
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    // SAFETY: `listen` has resolved, so the server is bound and `address()`
    // is an `AddressInfo` carrying the port it was given.
    frontPort = (front.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const server of [front, upstream]) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("streams the delivery untouched and returns the ingress answer", async () => {
    // A body larger than one TCP chunk, sent in pieces, must arrive intact:
    // the proxy pipes and never buffers, and the ingress's own 1 MB cap is
    // what bounds the size.
    const payload = Buffer.alloc(256 * 1024, "x").toString("utf8");
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: frontPort,
          method: "POST",
          path: "/hooks/wh_stream/s3cr3t?source=test",
          headers: {
            "content-type": "application/json",
            "cf-ray": "fixture-ray",
            "x-github-delivery": "fixture-delivery-1",
            // Hop-by-hop headers the edge may set: the proxy must strip them
            // (and anything `connection` nominates) before the loopback hop.
            connection: "x-hop-fixture",
            "x-hop-fixture": "must-not-forward",
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      const half = Math.floor(payload.length / 2);
      req.write(payload.slice(0, half));
      setTimeout(() => {
        req.write(payload.slice(half));
        req.end();
      }, 25);
    });
    expect(answer.status).toBe(202);
    expect(JSON.parse(answer.body)).toEqual({ accepted: true });
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/hooks/wh_stream/s3cr3t?source=test");
    expect(seen.body.length).toBe(256 * 1024);
    // Edge markers and the delivery id stay on the forwarded headers as
    // provenance; the Host is the ingress's own loopback address.
    expect(seen.headers["cf-ray"]).toBe("fixture-ray");
    expect(seen.headers["x-github-delivery"]).toBe("fixture-delivery-1");
    expect(seen.headers["host"]).toBe(`127.0.0.1:${upstreamPort}`);
    // The hop-by-hop header `connection` nominated never reached the ingress.
    expect(seen.headers["x-hop-fixture"]).toBeUndefined();
  });

  it("answers 504 when the ingress stalls past the proxy timeout", async () => {
    const stalling = createServer(() => {
      // Never answers: the proxy timeout is what saves the delivery.
    });
    await new Promise<void>((resolve) => stalling.listen(0, "127.0.0.1", resolve));
    // SAFETY: `listen` has resolved, so the server is bound and `address()`
    // is an `AddressInfo` carrying the port it was given.
    const stallingPort = (stalling.address() as AddressInfo).port;
    const slowFront = createServer((req, res) => {
      void proxyTunnelWebhook(req, res, { port: stallingPort, timeoutMs: 100 }).catch((error: unknown) => {
        console.warn("test proxy failure:", error instanceof Error ? error.message : "unknown error");
      });
    });
    await new Promise<void>((resolve) => slowFront.listen(0, "127.0.0.1", resolve));
    // SAFETY: `listen` has resolved, so the server is bound and `address()`
    // is an `AddressInfo` carrying the port it was given.
    const slowPort = (slowFront.address() as AddressInfo).port;
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: slowPort, method: "POST", path: "/hooks/wh_slow/secret" },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    await new Promise<void>((resolve) => slowFront.close(() => resolve()));
    await new Promise<void>((resolve) => stalling.close(() => resolve()));
    expect(answer.status).toBe(504);
    expect(JSON.parse(answer.body).error).toMatch(/timed out/);
  });

  it("answers 502 when the ingress is not listening", async () => {
    // This front targets a port nothing listens on.
    const deadFront = createServer((req, res) => {
      void proxyTunnelWebhook(req, res, { port: 1 }).catch((error: unknown) => {
        console.warn("test proxy failure:", error instanceof Error ? error.message : "unknown error");
      });
    });
    await new Promise<void>((resolve) => deadFront.listen(0, "127.0.0.1", resolve));
    // SAFETY: `listen` has resolved, so the server is bound and `address()`
    // is an `AddressInfo` carrying the port it was given.
    const deadPort = (deadFront.address() as AddressInfo).port;
    const deadAnswer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: deadPort, method: "POST", path: "/hooks/wh_down/secret" },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    await new Promise<void>((resolve) => deadFront.close(() => resolve()));
    expect(deadAnswer.status).toBe(502);
    expect(JSON.parse(deadAnswer.body).error).toMatch(/unavailable/);
  });
});

describe("hooks tunnel proxy through the booted harness", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  const PORT = 28800 + Math.floor(Math.random() * 8_000);
  const WEBHOOK_PORT = PORT + 1;
  const BASE = `http://127.0.0.1:${PORT}`;

  const post = async (
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-hooks-proxy-test-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(join(home, ".botfleet", "config.json"), JSON.stringify({}));
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      OMB_WEBHOOK_PORT: String(WEBHOOK_PORT),
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if (await harnessReady(BASE)) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 120_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it("proxies POST /hooks/* via the tunnel to the ingress, which still refuses a bad secret", async () => {
    const res = await post("/hooks/wh_missing/wrong-secret", { "cf-ray": "fixture-ray" });
    // A 401 is the ingress's own answer to a bad capability URL: it proves
    // the delivery was proxied off the harness and authenticated there.
    // The harness alone would have answered 404 `no route`.
    expect(res.status).toBe(401);
    expect(String(res.body?.error)).toMatch(/Invalid webhook/);
  });

  it("proxies POST /zulip/outgoing/* via the tunnel to the ingress", async () => {
    const res = await post("/zulip/outgoing/WISE", { "cf-ray": "fixture-ray" });
    // The Zulip route answers with its own payload/identity verdicts (the
    // fixture configures no Zulip bot).  Any of those proves the proxy
    // carried the delivery; the harness alone would answer 404 `no route`.
    expect([400, 404, 415, 503]).toContain(res.status);
    expect(String(res.body?.error)).not.toMatch(/no route/);
  });

  it("still refuses a mutating /api/* call that arrives via the tunnel", async () => {
    const res = await post("/api/bots", { "cf-ray": "fixture-ray" });
    expect(res.status).toBe(403);
    expect(String(res.body?.error)).toMatch(/named tunnel/);
  });

  it("leaves a loopback caller without edge markers on the harness's own answer", async () => {
    const res = await post("/hooks/wh_missing/wrong-secret", {});
    expect(res.status).toBe(404);
    expect(String(res.body?.error)).toMatch(/no route/);
  });
});
