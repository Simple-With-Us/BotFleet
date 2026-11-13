// Does pi proxy the job tools?  (jobs P2, requirement 2)
//
// The question is not whether `buildMcpServers` passes the `agents` server to
// pi — that is readable in a glance — but whether pi's MCP client actually
// reaches a mounted server and hands the model a working tool.  So this file
// runs the REAL chain with no stand-in in the middle: the real
// `pi-mcp-extension`, pointed at the real `agents-proxy` process, spawned with
// `OMB_JOBS=1`, talking to a scripted stub of the harness.
//
// The only fake is pi itself, which is the one thing this Mac cannot run (and
// the one thing under test would otherwise be).  The fake is the real
// ExtensionAPI surface the extension uses — `registerTool` and `on` — and the
// assertion is on what the extension did with a real MCP server: it registered
// the four job tools, and calling one reached the harness endpoint.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import extension from "./pi-mcp-extension.ts";
import { buildMcpServers } from "./pi.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "agents-proxy.ts");
const TOKEN = "test-comms-token";
const JOB = "job_01M3XZ11GH0ZB6RG6V6KSJWR1W";

type RegisteredTool = Parameters<Parameters<typeof extension>[0]["registerTool"]>[0];
type ShutdownHandler = Parameters<Parameters<typeof extension>[0]["on"]>[1];

const dirs: string[] = [];
const servers: Server[] = [];
const originalConfig = process.env.OMB_MCP_CONFIG;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-pi-jobs-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalConfig === undefined) delete process.env.OMB_MCP_CONFIG;
  else process.env.OMB_MCP_CONFIG = originalConfig;
});

/** The harness half: a loopback stub that records what reached it. */
async function stubHarness(): Promise<{ url: string; paths: string[]; bodies: any[] }> {
  const paths: string[] = [];
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      paths.push(path);
      try {
        bodies.push(data ? JSON.parse(data) : {});
      } catch {
        bodies.push({});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: `Started ${JOB} \`echo hi\` in /tmp.` }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, paths, bodies };
}

/** Point the extension at a REAL `agents-proxy` with jobs mounted, drive it
 *  with a fake pi, and hand back what the extension registered. */
async function registerThroughPi(harnessUrl: string): Promise<{ tools: RegisteredTool[]; shutdown: ShutdownHandler | undefined }> {
  const dir = tempDir();
  const config = join(dir, "mcp.json");
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        // Exactly the shape `agentsIntegration` produces, jobs included: a
        // command, the proxy as its only argument, and the env the harness
        // mints.  No `scope`, because the job tools' approval is the harness's
        // permission broker and not pi's own confirm card.
        agents: {
          command: process.execPath,
          args: [PROXY],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            NODE_OPTIONS: "--experimental-strip-types --no-warnings",
            OMB_HARNESS_URL: harnessUrl,
            OMB_BOT_ID: "bot_me",
            OMB_THREAD_ID: "thread_me",
            OMB_COMMS_TOKEN: TOKEN,
            OMB_TURN_DEPTH: "0",
            OMB_JOBS: "1",
          },
        },
      },
    }),
    "utf8",
  );
  process.env.OMB_MCP_CONFIG = config;

  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, ShutdownHandler>();
  await extension({
    registerTool(tool) {
      tools.push(tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  });
  return { tools, shutdown: handlers.get("session_shutdown") };
}

describe("pi and the job tools (jobs P2)", () => {
  it("hands pi's MCP config the agents server, jobs and all", () => {
    // The driver half, pinned directly: the mount is in the config pi reads.
    const servers = buildMcpServers({
      threadId: "t",
      text: "",
      integrations: {
        agents: { command: "/usr/bin/node", args: ["/proxy.mjs"], env: { OMB_JOBS: "1" } },
      },
    } as never);
    expect(servers).not.toBeNull();
    expect((servers as Record<string, { env: Record<string, string> }>).agents.env.OMB_JOBS).toBe("1");
  });

  it("registers the four job tools as real pi tools", async () => {
    const harness = await stubHarness();
    const { tools, shutdown } = await registerThroughPi(harness.url);
    try {
      // Namespaced by server, which is how the extension keeps two servers'
      // tools from colliding — so the model sees `agents_job_start`, and the
      // label carries the plain MCP name for the card and the transcript.
      const names = tools.map((tool) => tool.name);
      for (const name of ["job_start", "job_output", "job_list", "job_kill"]) {
        expect(names).toContain(`agents_${name}`);
      }
      expect(tools.find((tool) => tool.name === "agents_job_start")!.label).toBe("agents:job_start");
    } finally {
      await shutdown?.();
    }
  });

  it("reaches the harness when the model calls one, so pi is a supported engine", async () => {
    const harness = await stubHarness();
    const { tools, shutdown } = await registerThroughPi(harness.url);
    try {
      const jobStart = tools.find((tool) => tool.name === "agents_job_start")!;
      const out = await jobStart.execute(
        "call-1",
        { command: "echo hi" },
        undefined,
        undefined,
        { ui: { confirm: async () => true } },
      );
      // The whole chain moved: model -> pi tool -> extension -> real
      // agents-proxy -> harness endpoint, and the words came back.
      expect(harness.paths).toContain("/api/internal/jobs/start");
      expect(harness.bodies).toContainEqual({ command: "echo hi" });
      expect(out.content.map((c: any) => c.text).join("")).toContain(JOB);
    } finally {
      await shutdown?.();
    }
  });
});
