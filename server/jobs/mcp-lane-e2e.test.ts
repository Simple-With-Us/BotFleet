// The MCP lane, end to end (jobs P2): the real `agents-proxy` process, spawned
// exactly as a driver's mcpServers entry spawns it, talking to a scripted stub
// of the harness's `/api/internal/jobs` endpoints.
//
// The stub is a HARNESS stub, not a harness: the whole point is to prove the
// wire — that `tools/list` publishes the four job tools only with `OMB_JOBS=1`,
// and that a call arrives at the right path with the model's own arguments and
// nothing else.  What the endpoints do with a call is `mcp-lane.test.ts`'s job,
// against the real registry.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "..", "drivers", "agents-proxy.ts");
const TOKEN = "test-comms-token";
const JOB = "job_01M3XZ11GH0ZB6RG6V6KSJWR1W";

let stub: Server;
let stubPort = 0;
const calls: Array<{ path: string; auth?: string; body: any }> = [];
let refusals = 0;

let child: ChildProcess;
const pending = new Map<number, (msg: any) => void>();
let nextId = 100;

function rpc(method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 10_000).unref?.();
  });
}

const listTools = () => rpc("tools/list");
const callTool = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });
const names = async (): Promise<string[]> => (await listTools()).result.tools.map((t: any) => t.name);
const textOf = (r: any): string =>
  (r.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString("utf8")));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

beforeAll(async () => {
  stub = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const body = req.method === "GET" ? {} : await readBody(req);
    calls.push({ path, auth: req.headers.authorization as string, body });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    // A refused start comes back as text with isError, exactly as the lane
    // sends it, so the proxy's isError pass-through is observable.
    if (refusals > 0) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: "The job was not started: the request to run it was denied.", isError: true }));
    }
    if (path === "/api/internal/jobs") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: `${JOB}  running  \`sleep 30\`  0m 03s` }));
    }
    if (path === "/api/internal/jobs/start") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: `Started ${JOB} \`echo hi\` in /tmp.` }));
    }
    if (path === "/api/internal/jobs/output") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: "[UNTRUSTED JOB OUTPUT job_1]\nhi\n[/UNTRUSTED JOB OUTPUT]\n[status: completed]" }));
    }
    if (path === "/api/internal/jobs/kill") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ text: `Stopped ${JOB}.` }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubPort = (stub.address() as { port: number }).port;

  child = spawn(
    process.execPath,
    [PROXY],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--experimental-strip-types --no-warnings",
        OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
        OMB_BOT_ID: "bot_me",
        OMB_THREAD_ID: "thread_me",
        OMB_COMMS_TOKEN: TOKEN,
        OMB_TURN_DEPTH: "0",
        OMB_JOBS: "1",
      },
    },
  );
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
});

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe("the job tools on the CLI MCP wire", () => {
  it("publishes all four when the harness mounted them", async () => {
    const published = await names();
    for (const name of ["job_start", "job_output", "job_list", "job_kill"]) expect(published).toContain(name);
  });

  it("advertises the MCP lane's 120-second wait, not the HTTP lane's 75", async () => {
    const jobOutput = (await listTools()).result.tools.find((t: any) => t.name === "job_output");
    expect(jobOutput.description).toContain("at most 120");
    expect(jobOutput.inputSchema.properties.wait_seconds.description).toContain("at most 120");
  });

  it("carries only the model's own arguments to job_start, never an identity", async () => {
    calls.length = 0;
    await callTool("job_start", { command: "echo hi" });
    const start = calls.find((c) => c.path === "/api/internal/jobs/start");
    expect(start).toBeDefined();
    // No botId, no threadId: the token's binding is the identity, and the
    // harness reads it from the Authorization header instead.
    expect(start!.body).toEqual({ command: "echo hi" });
    expect(start!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("reaches each tool's own endpoint with its own arguments", async () => {
    calls.length = 0;
    await callTool("job_output", { job_id: JOB, wait_seconds: 120 });
    expect(calls.find((c) => c.path === "/api/internal/jobs/output")!.body).toEqual({ job_id: JOB, wait_seconds: 120 });

    await callTool("job_list", {});
    expect(calls.find((c) => c.path === "/api/internal/jobs")).toBeDefined();

    await callTool("job_kill", { job_id: JOB });
    expect(calls.find((c) => c.path === "/api/internal/jobs/kill")!.body).toEqual({ job_id: JOB });
  });

  it("returns the lane's words to the model verbatim", async () => {
    expect(textOf(await callTool("job_list", {}))).toContain(JOB);
    expect(textOf(await callTool("job_output", { job_id: JOB }))).toContain("UNTRUSTED JOB OUTPUT");
  });

  it("carries a refusal back as an error, so a denied start cannot read as a started job", async () => {
    refusals += 1;
    const out = await callTool("job_start", { command: "echo hi" });
    refusals -= 1;
    expect(out.result.isError).toBe(true);
    expect(textOf(out)).toMatch(/not started/i);
  });
});

describe("a proxy spawned without jobs", () => {
  it("publishes no job tools at all", async () => {
    const bare = spawn(
      process.execPath,
      [PROXY],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: "--experimental-strip-types --no-warnings",
          OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
          OMB_BOT_ID: "bot_me",
          OMB_THREAD_ID: "thread_me",
          OMB_COMMS_TOKEN: TOKEN,
          OMB_TURN_DEPTH: "0",
          // No OMB_JOBS: this is every lane that did not mount jobs.
        },
      },
    );
    const tools: any[] = await new Promise((resolve, reject) => {
      let out = "";
      bare.stdout!.setEncoding("utf8");
      bare.stdout!.on("data", (chunk: string) => {
        out += chunk;
        const nl = out.indexOf("\n");
        if (nl < 0) return;
        try {
          resolve(JSON.parse(out.slice(0, nl)).result.tools);
        } catch (err) {
          reject(err);
        }
      });
      bare.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
      setTimeout(() => reject(new Error("tools/list timed out")), 10_000).unref?.();
    });
    bare.kill();
    const bareNames = tools.map((t) => t.name);
    for (const name of ["job_start", "job_output", "job_list", "job_kill"]) expect(bareNames).not.toContain(name);
    // The fleet tools this wire already shipped are untouched.
    expect(bareNames).toContain("ask_bot");
  });
});
