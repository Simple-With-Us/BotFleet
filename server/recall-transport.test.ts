import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeRecallCli, fetchRecall, probeRecallService, recallStatus, selectRecallTransport,
  validateRecallStats, RECALL_SKIP_PRIVATE_ENV,
} from "./recall-transport.ts";

const servers: Server[] = [];
const valid = { collection: "selected-corpus", points: 0, status: "green", embedder_healthy: true };
async function service(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe("Recall readiness evidence", () => {
  it.each([401, 403, 404, 500])("rejects a public healthy route with protected stats HTTP %i", async (status) => {
    const url = await service((req, res) => json(res, req.url === "/health" ? { backend_ok: true } : {}, req.url === "/health" ? 200 : status));
    await expect(probeRecallService(url, {}, "selected-corpus", AbortSignal.timeout(1000))).rejects.toThrow(`HTTP ${status}`);
  });
  it.each([
    { ...valid, backend_ok: false }, { ...valid, embedder_healthy: false }, { ...valid, points: -1 },
    { ...valid, collection: "other-corpus" }, { ...valid, status: "red" }, { ok: true },
    { collections: [{ name: "selected-corpus" }] },
  ])("does not infer readiness from incomplete or unhealthy statistics: %j", (stats) => {
    expect(validateRecallStats(stats, "selected-corpus").stats).toBeUndefined();
  });
  it("accepts a healthy empty corpus after protected-route proof", async () => {
    const paths: string[] = [];
    const url = await service((req, res) => { paths.push(req.url!); json(res, req.url === "/health" ? { backend_ok: true } : valid); });
    expect(await probeRecallService(url, {}, "selected-corpus", AbortSignal.timeout(1000))).toEqual(valid);
    expect(paths).toEqual(["/health", "/recall/stats"]);
  });
  it("bounds a stalled protected response with the same whole-probe deadline", async () => {
    const url = await service((req, res) => { if (req.url === "/health") json(res, { backend_ok: true }); });
    const started = Date.now();
    await expect(probeRecallService(url, {}, "selected-corpus", AbortSignal.timeout(100))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
  });
  it("coalesces matching probes and preserves last success while reporting a later failure", async () => {
    let unhealthy = false;
    let statsCalls = 0;
    const url = await service((req, res) => {
      if (req.url === "/recall/stats") statsCalls++;
      json(res, req.url === "/health" ? { backend_ok: !unhealthy } : valid);
    });
    const settings = { url, collection: "selected-corpus", apiKey: "", accessClientId: "", accessClientSecret: "" };
    const first = recallStatus(settings);
    expect(recallStatus(settings)).toBe(first);
    const success = await first;
    expect(success).toMatchObject({ ready: true, state: "ready", pointsCount: 0, source: "recall-service" });
    expect(statsCalls).toBe(1);
    expect((await recallStatus({ ...settings, apiKey: "second-configuration-fixture" })).ready).toBe(true);
    unhealthy = true;
    expect(await recallStatus(settings)).toMatchObject({ ready: false, state: "degraded", lastSuccessAt: success.lastSuccessAt });
  });

  it("reports a half-configured Access pair even on a healthy probe", async () => {
    // Half a pair sends no Access headers at all, so a service behind Access
    // answers a login page — and the panel has nothing to say about it
    // unless the status payload carries which half is missing.  The probe
    // itself can be perfectly green (this one is), which is exactly why the
    // state rides along with it rather than only with an error.
    const url = await service((_req, res) => json(res, valid));
    const base = { url, collection: "selected-corpus", apiKey: "" };

    expect(await recallStatus({ ...base, accessClientId: "", accessClientSecret: "shhh" }))
      .toMatchObject({ ready: true, accessTokenState: "missing-id" });
    expect(await recallStatus({ ...base, accessClientId: "fixture.access", accessClientSecret: "" }))
      .toMatchObject({ ready: true, accessTokenState: "missing-secret" });
    expect(await recallStatus({ ...base, accessClientId: "fixture.access", accessClientSecret: "shhh" }))
      .toMatchObject({ accessTokenState: "complete" });
    expect(await recallStatus({ ...base, accessClientId: "", accessClientSecret: "" }))
      .toMatchObject({ accessTokenState: "none" });
  });
});

describe("Recall transport credential and process boundaries", () => {
  it("never forwards bearer or Access credentials to a different origin", async () => {
    let reached = false;
    const destination = await service((_req, res) => { reached = true; json(res, valid); });
    const url = await service((_req, res) => { res.writeHead(307, { location: destination }); res.end(); });
    const response = await fetchRecall(url, { headers: { Authorization: "Bearer fixture", "CF-Access-Client-Secret": "fixture" }, signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(307);
    expect(reached).toBe(false);
    await response.body?.cancel();
  });
  it("preserves a POST body across a same-origin 307", async () => {
    const seen: string[] = [];
    const url = await service((req, res) => {
      if (req.url === "/start") { res.writeHead(307, { location: "/finish" }); res.end(); return; }
      req.on("data", (chunk) => seen.push(chunk.toString()));
      req.on("end", () => json(res, valid));
    });
    const response = await fetchRecall(`${url}/start`, { method: "POST", body: "fixture", signal: AbortSignal.timeout(1000) });
    expect(await response.json()).toEqual(valid);
    expect(seen.join("")).toBe("fixture");
  });
  it("passes the selected collection to a local CLI", async () => {
    expect(await executeRecallCli(process.execPath, ["-e", "process.stdout.write(process.env.QDRANT_FLEET_COLLECTION)"], "selected-corpus", 2000)).toBe("selected-corpus");
  });
  it("asks the local CLI to skip Tailscale and the private Qdrant path", async () => {
    expect(await executeRecallCli(
      process.execPath,
      ["-e", `process.stdout.write(process.env.${RECALL_SKIP_PRIVATE_ENV} || "")`],
      "",
      2000,
    )).toBe("1");
  });
  it("honors an explicit service URL instead of a local CLI", () => {
    expect(selectRecallTransport("https://recall.jays.services", "/usr/bin/recall")).toBe("recall-service");
    expect(selectRecallTransport("", "/usr/bin/recall")).toBe("recall-cli");
    expect(selectRecallTransport("", null)).toBe("unconfigured");
  });
  it("bounds a hung local CLI and its output pipes", async () => {
    const started = Date.now();
    await expect(executeRecallCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], "", 100)).rejects.toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(1500);
  });
  it.skipIf(process.platform === "win32")("kills a hung descendant in the same process group", async () => {
    const dir = join(tmpdir(), `recall-group-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, "child.pid");
    const script = join(dir, "hang.js");
    writeFileSync(script, `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
      setInterval(() => {}, 1000);
    `);
    const started = Date.now();
    await expect(executeRecallCli(process.execPath, [script], "", 800)).rejects.toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(existsSync(marker)).toBe(true);
    const pid = Number(readFileSync(marker, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(() => process.kill(pid, 0)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
  it.skipIf(process.platform === "win32")("reports a hung local CLI as degraded inside the deadline", async () => {
    const dir = join(tmpdir(), `recall-hang-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const cli = join(dir, "recall");
    writeFileSync(cli, "#!/bin/sh\nexec sleep 120\n", { mode: 0o755 });
    expect(existsSync(cli)).toBe(true);
    const previous = process.env.RECALL_CLI_PATH;
    process.env.RECALL_CLI_PATH = cli;
    try {
      const started = Date.now();
      const status = await recallStatus({
        url: "", apiKey: "", collection: `deadline-${Date.now()}`,
        accessClientId: "", accessClientSecret: "",
      }, 200);
      expect(status).toMatchObject({ ready: false, state: "degraded", source: "recall-cli" });
      expect(String(status.error)).toMatch(/timed out/i);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      if (previous === undefined) delete process.env.RECALL_CLI_PATH;
      else process.env.RECALL_CLI_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
