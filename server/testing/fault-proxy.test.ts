import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { startFaultProxy, type FaultProxy } from "./fault-proxy.ts";
import { nonceRuns, startFixtureChild, startFixturePair, type FixtureChildSpec } from "./two-process.ts";

const run = promisify(execFile);
const nonceJob = fileURLToPath(new URL("./nonce-job.mjs", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A far side that counts what it acted on, standing in for a controller. */
async function counter(): Promise<{ port: number; hits: () => string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      hits.push(`${req.method} ${req.url} ${Buffer.concat(parts).toString("utf8")}`);
      res.writeHead(200, { "content-type": "application/json", "x-fixture": "kept" }).end(JSON.stringify({ seen: hits.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  // SAFETY: address() on a server listening on TCP is an AddressInfo, never a string or null.
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

async function proxied(targetPort: number): Promise<FaultProxy> {
  const proxy = await startFaultProxy({ targetPort });
  cleanups.push(() => proxy.close());
  return proxy;
}

/** Sends one request and reports the outcome, because a lost message is the point. */
function send(port: number, path: string, body = "{}"): Promise<{ status: number; body: string; headers: IncomingHttpHeaders } | "connection-lost"> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST", agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (part: Buffer) => parts.push(part));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8"), headers: res.headers }));
      res.on("error", () => resolve("connection-lost"));
    });
    req.on("error", () => resolve("connection-lost"));
    req.end(body);
  });
}

describe("fault proxy", () => {
  it("passes a request and its answer through unchanged when no fault is armed", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    const answer = await send(proxy.port, "/a", '{"n":1}');
    expect(answer).toMatchObject({ status: 200, body: '{"seen":1}', headers: { "x-fixture": "kept" } });
    expect(far.hits()).toEqual(['POST /a {"n":1}']);
    expect(proxy.exchanges()[0]).toMatchObject({ upstreamStatus: 200, fault: null });
  });

  it("a dropped request never reaches the far side", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    proxy.dropNext("request");
    expect(await send(proxy.port, "/a")).toBe("connection-lost");
    expect(far.hits()).toEqual([]);
    expect(proxy.exchanges()[0]).toMatchObject({ upstreamStatus: null, fault: "request-dropped" });
  });

  it("a dropped acknowledgement is acted on by the far side and lost on the way back", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    proxy.dropNext("response");
    expect(await send(proxy.port, "/a")).toBe("connection-lost");
    expect(far.hits()).toHaveLength(1);
    expect(proxy.exchanges()[0]).toMatchObject({ upstreamStatus: 200, fault: "response-dropped" });
  });

  it("a fault is spent once and only on a matching request", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    proxy.dropNext("response", (exchange) => exchange.path === "/report");
    expect(await send(proxy.port, "/heartbeat")).toMatchObject({ status: 200 });
    expect(await send(proxy.port, "/report")).toBe("connection-lost");
    expect(await send(proxy.port, "/report")).toMatchObject({ status: 200 });
    expect(far.hits()).toHaveLength(3);
  });

  it("replay delivers the same request to the far side again", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    proxy.dropNext("response");
    await send(proxy.port, "/report", '{"job":"x"}');
    const replayed = await proxy.replay(proxy.exchanges()[0]);
    expect(replayed.status).toBe(200);
    expect(far.hits()).toEqual(['POST /report {"job":"x"}', 'POST /report {"job":"x"}']);
    expect(proxy.exchanges()).toHaveLength(1);
  });

  it("refuses connections while the link is down and recovers after", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    proxy.setRefusing(true);
    expect(await send(proxy.port, "/a")).toBe("connection-lost");
    expect(far.hits()).toEqual([]);
    proxy.setRefusing(false);
    expect(await send(proxy.port, "/a")).toMatchObject({ status: 200 });
  });

  it("cuts a connection whose answer has not arrived", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    const held = new Promise<string>((resolve) => {
      const req = request({ host: "127.0.0.1", port: proxy.port, path: "/slow", method: "POST", agent: false });
      req.on("error", () => resolve("connection-lost"));
      req.on("response", () => resolve("answered"));
      req.write("partial");
      setTimeout(() => proxy.cutConnections(), 50);
    });
    expect(await held).toBe("connection-lost");
    expect(far.hits()).toEqual([]);
    // A request cut before its body finished was never read in full, so it is not logged,
    // and the proxy still answers the next one.
    expect(proxy.exchanges()).toEqual([]);
    expect(await send(proxy.port, "/after")).toMatchObject({ status: 200 });
  });

  it("hands out a copy of the log, so a caller cannot change what later assertions count", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    await send(proxy.port, "/a");
    expect(proxy.exchanges()).not.toBe(proxy.exchanges());
    expect(proxy.exchanges()).toHaveLength(1);
  });

  it("answers 502 instead of buffering an oversized answer from the far side", async () => {
    const big: Server = createServer((_req, res) => { res.end(Buffer.alloc(2 * 1024 * 1024)); });
    await new Promise<void>((resolve) => big.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { big.close(() => resolve()); }));
    // SAFETY: address() on a server listening on TCP is an AddressInfo, never a string or null.
    const proxy = await proxied((big.address() as AddressInfo).port);
    expect(await send(proxy.port, "/a")).toMatchObject({ status: 502 });
  });

  it("answers 413 for a request past the limit without forwarding it", async () => {
    const far = await counter();
    const proxy = await proxied(far.port);
    const answer = await send(proxy.port, "/a", "x".repeat(2 * 1024 * 1024));
    expect(answer === "connection-lost" || answer.status === 413).toBe(true);
    expect(far.hits()).toEqual([]);
  });

  it("answers 502 when the far side is gone", async () => {
    const far = await counter();
    const proxy = await startFaultProxy({ targetPort: far.port });
    cleanups.push(() => proxy.close());
    await cleanups.shift()?.();
    expect(await send(proxy.port, "/a")).toMatchObject({ status: 502 });
  });
});

describe("two-process fixtures", () => {
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "bf-two-process-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const listener = (label: string, env: NodeJS.ProcessEnv = {}): FixtureChildSpec & { port: () => number } => {
    let port = 0;
    const portFile = join(home(), `${label}.port`);
    const script = `const s=require('node:http').createServer((q,r)=>r.end(process.env.WHO));s.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync(${JSON.stringify(portFile)},String(s.address().port)))`;
    return {
      label, command: process.execPath, args: ["-e", script], env: { WHO: label, ...env }, timeoutMs: 15_000,
      port: () => port,
      ready: async () => {
        try {
          const { readFileSync } = await import("node:fs");
          port = Number(readFileSync(portFile, "utf8"));
          return (await (await fetch(`http://127.0.0.1:${port}/`)).text()) === label;
        } catch { return false; }
      },
    };
  };

  it("starts two real processes, reaches each, and stops both", async () => {
    const controller = listener("controller");
    const worker = listener("worker");
    const pair = await startFixturePair({ controller, worker });
    cleanups.push(() => pair.stop());
    expect(pair.controller.child.pid).not.toBe(pair.worker.child.pid);
    expect(await (await fetch(`http://127.0.0.1:${controller.port()}/`)).text()).toBe("controller");
    await pair.stop();
    await pair.stop();
    expect(pair.controller.child.exitCode !== null || pair.controller.child.signalCode !== null).toBe(true);
    expect(pair.worker.child.exitCode !== null || pair.worker.child.signalCode !== null).toBe(true);
  });

  it("a worker that cannot start stops the controller and reports why", async () => {
    const controller = listener("controller");
    const started = startFixturePair({
      controller,
      worker: { label: "worker", command: process.execPath, args: ["-e", "console.error('no such capability');process.exit(3)"], env: {}, ready: async () => false },
    });
    await expect(started).rejects.toThrow(/worker exited before it was ready: .*no such capability/s);
    await expect(fetch(`http://127.0.0.1:${controller.port()}/`)).rejects.toThrow();
  });

  /** Starts a long-lived child and reports its pid, whatever the probe then does. */
  const probeWith = async (ready: () => Promise<boolean>, timeoutMs: number): Promise<{ error: Error; pid: number }> => {
    const dir = home();
    const pidFile = join(dir, "pid");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const { readFileSync } = await import("node:fs");
    const wrapped = async (): Promise<boolean> => {
      try { readFileSync(pidFile); } catch { return false; }
      return ready();
    };
    const error = await startFixtureChild({ label: "probe", command: process.execPath, args: ["-e", script], env: {}, ready: wrapped, timeoutMs })
      .then(() => { throw new Error("the child should not have become ready"); }, (reason: Error) => reason);
    return { error, pid: Number(readFileSync(pidFile, "utf8")) };
  };
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  it("stops the child when its readiness probe throws", async () => {
    const { error, pid } = await probeWith(async () => { throw new Error("probe broke"); }, 15_000);
    expect(error.message).toBe("probe broke");
    expect(alive(pid)).toBe(false);
  });

  it("stops the child when its readiness probe hangs past the deadline", async () => {
    const { error, pid } = await probeWith(() => new Promise<boolean>(() => {}), 1_500);
    expect(error.message).toMatch(/probe was not ready in time/);
    expect(alive(pid)).toBe(false);
  });

  it("gives a child only the environment it names, plus PATH", async () => {
    process.env.BF_TWO_PROCESS_LEAK = "leak";
    cleanups.push(() => { delete process.env.BF_TWO_PROCESS_LEAK; });
    const dir = home();
    const out = join(dir, "env.json");
    const child = await startFixtureChild({
      label: "probe", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(out)},JSON.stringify(process.env));setInterval(()=>{},1000)`],
      env: { NAMED: "yes" },
      ready: async () => { try { (await import("node:fs")).readFileSync(out); return true; } catch { return false; } },
    });
    cleanups.push(() => child.stop());
    // SAFETY: the child above wrote this file from process.env, whose values are all strings.
    const seen = JSON.parse((await import("node:fs")).readFileSync(out, "utf8")) as Record<string, string>;
    expect(seen.NAMED).toBe("yes");
    expect(seen.BF_TWO_PROCESS_LEAK).toBeUndefined();
  });
});

describe("nonce job", () => {
  it("leaves one file per real run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-nonce-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(nonceRuns(dir, "job-1")).toEqual([]);
    await run(process.execPath, [nonceJob, dir, "job-1"]);
    expect(nonceRuns(dir, "job-1")).toHaveLength(1);
    await run(process.execPath, [nonceJob, dir, "job-1"]);
    await run(process.execPath, [nonceJob, dir, "job-2"]);
    expect(nonceRuns(dir, "job-1")).toHaveLength(2);
    expect(nonceRuns(dir, "job-2")).toHaveLength(1);
  });

  it("does not count a stray file as a run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-nonce-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "job-1.run"), "");
    writeFileSync(join(dir, "job-1.notes.run"), "");
    writeFileSync(join(dir, "job-1.123.run"), "");
    expect(nonceRuns(dir, "job-1")).toEqual([]);
    await run(process.execPath, [nonceJob, dir, "job-1"]);
    const runs = nonceRuns(dir, "job-1");
    expect(runs).toHaveLength(1);
    expect(Number.isInteger(runs[0])).toBe(true);
  });

  it("refuses a nonce that could escape its directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-nonce-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    await expect(run(process.execPath, [nonceJob, dir, "../escape"])).rejects.toMatchObject({ code: 2 });
  });
});
