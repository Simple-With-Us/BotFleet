// Contract test for the Agent RAG proxy's configuration boundary.
//
// BotFleet ships no recall endpoint and no collection name. With nothing
// configured and no local `recall` CLI on the host, every tool must say so
// and touch the network zero times — the failure this guards against is a
// built-in default quietly sending a user's prompts to somebody else's
// server.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { RECALL_STATUS_TIMEOUT_MS, RECALL_TOOL_TIMEOUT_MS } from "../recall-transport.ts";

/** Every env var the proxy reads for its endpoint, key, collection, and CLI
 * path — cleared so a developer's own shell cannot configure the child. */
const PROXY_ENV_KEYS = [
  "OMB_RECALL_URL",
  "RECALL_URL",
  "OMB_QDRANT_URL",
  "QDRANT_URL",
  "OMB_RECALL_API_KEY",
  "RECALL_API_KEY",
  "OMB_QDRANT_API_KEY",
  "QDRANT_API_KEY",
  "OMB_RECALL_COLLECTION",
  "RECALL_COLLECTION",
  "OMB_QDRANT_COLLECTION",
  "QDRANT_COLLECTION",
  "RECALL_CLI_PATH",
  "OMB_RECALL_ACCESS_CLIENT_ID",
  "OMB_QDRANT_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_ID",
  "OMB_RECALL_ACCESS_CLIENT_SECRET",
  "OMB_QDRANT_ACCESS_CLIENT_SECRET",
  "CF_ACCESS_CLIENT_SECRET",
] as const;

const NOT_CONFIGURED = "Bot RAG is not configured — set a Service URL in Settings";

/** The tool arguments these tests send — a named contract, not a bag. */
interface ToolArgs {
  query?: string;
  topic?: string;
  text?: string;
  category?: string;
  limit?: number;
}
type RpcParams = { name: string; arguments: ToolArgs } | Record<string, never>;

let child: ChildProcess | null = null;
let stub: Server | null = null;

function cleanEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  // setup.ts already points HOME at a throwaway directory, so homedir()
  // in the child holds no ~/.local/bin/recall.
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  for (const key of PROXY_ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}

/** Launch the proxy and return a JSON-RPC caller over its stdio. */
function launch(overrides: Record<string, string> = {}) {
  const proc = spawn(process.execPath, [SPAWNED_PROXIES.qdrant], {
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv(overrides),
  });
  child = proc;

  const pending = new Map<number, (message: { result?: { content?: Array<{ text?: string }> } }) => void>();
  let nextId = 1;
  let buffer = "";
  proc.stdout!.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  const rpc = (method: string, params: RpcParams) =>
    new Promise<{ result?: { content?: Array<{ text?: string }>; tools?: unknown[] } }>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000).unref?.();
    });

  const callTool = async (name: string, args: ToolArgs = {}) => {
    const response = await rpc("tools/call", { name, arguments: args });
    return response.result?.content?.[0]?.text ?? "";
  };

  return { callTool, rpc };
}

afterEach(async () => {
  child?.kill("SIGKILL");
  child = null;
  if (stub) {
    const server = stub;
    stub = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("Agent RAG proxy with nothing configured", () => {
  it("reports the not-configured message from recall_search and never calls out", async () => {
    const { callTool } = launch();
    const text = await callTool("recall_search", { query: "how do we deploy" });

    expect(text).toBe(NOT_CONFIGURED);
    // A missing guard would surface as a request failure against an empty or
    // built-in URL, not as this message.
    expect(text).not.toMatch(/failed|http|fetch|recall\/search/i);
  });

  it("reports the not-configured message from recall_contribute", async () => {
    const { callTool } = launch();
    const text = await callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });

    expect(text).toBe(NOT_CONFIGURED);
  });

  it("reports the not-configured message from recall_stats and the qdrant aliases", async () => {
    const { callTool } = launch();

    expect(await callTool("recall_stats")).toBe(NOT_CONFIGURED);
    expect(await callTool("qdrant_list_collections")).toBe(NOT_CONFIGURED);
    expect(await callTool("qdrant_search", { query: "anything" })).toBe(NOT_CONFIGURED);
    expect(await callTool("qdrant_get_context", { topic: "anything" })).toBe(NOT_CONFIGURED);
  });

  it("advertises no owner-specific host, collection, or path in its tool schema", async () => {
    const { rpc } = launch();
    const response = await rpc("tools/list", {});
    const schema = JSON.stringify(response.result?.tools ?? []);

    expect(schema).not.toMatch(/jays\.services|fleet-agents|mac-collab|fleet-rag/);
    // the tools themselves must still be advertised
    expect(schema).toContain("recall_search");
  });
});

describe("Agent RAG proxy with a configured service", () => {
  it.each(["recall_search", "recall_contribute"])("blocks %s before sending content to the wrong corpus", async (tool) => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collection: "different-corpus", points: 2, backend_ok: true }));
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const { callTool } = launch({ OMB_QDRANT_URL: `http://127.0.0.1:${port}`, OMB_QDRANT_COLLECTION: "selected-corpus" });
    const text = await callTool(tool, { query: "private query", text: "private contribution" });
    expect(text).toContain("different collection");
    expect(paths).toEqual(["/health", "/recall/stats"]);
  });

  it("calls the configured endpoint and only that endpoint", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ hits: [{ text: "a stored lesson", score: 0.9 }], mode: "hybrid", collection: "agent-memory", points: 1, backend_ok: true }));
      });
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;

    const { callTool } = launch({
      OMB_QDRANT_URL: `http://127.0.0.1:${port}`,
      OMB_QDRANT_COLLECTION: "agent-memory",
    });
    const text = await callTool("recall_search", { query: "how do we deploy" });

    expect(seen).toEqual(["GET /health", "GET /recall/stats", "POST /recall/search"]);
    expect(text).toContain("a stored lesson");
    expect(text).toContain("agent-memory");
  });
});

describe("Agent RAG proxy behind Cloudflare Access", () => {
  /** Start a stub that records the credential headers of every request. */
  /** Node models a header as string | string[]; every one read here is
   * single-valued, so the first value is the value. */
  const headerValue = (raw: string | string[] | undefined): string | undefined =>
    Array.isArray(raw) ? raw[0] : raw;

  async function startRecordingService(handler: (req: { url: string }, res: import("node:http").ServerResponse) => void) {
    const seen: Array<{ path: string; accessId?: string; accessSecret?: string; authorization?: string }> = [];
    const server = createServer((req, res) => {
      seen.push({
        path: req.url ?? "",
        accessId: headerValue(req.headers["cf-access-client-id"]),
        accessSecret: headerValue(req.headers["cf-access-client-secret"]),
        authorization: headerValue(req.headers.authorization),
      });
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => handler({ url: req.url ?? "" }, res));
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;
    return { seen, url: `http://127.0.0.1:${port}` };
  }

  const okJson = (res: import("node:http").ServerResponse) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ hits: [{ text: "a stored lesson", score: 0.9 }], doc_id: "doc-1", collection: "agent-memory", points: 1, backend_ok: true }));
  };

  it("sends the Access service token alongside the bearer on search and contribute", async () => {
    const service = await startRecordingService((_req, res) => okJson(res));

    const { callTool } = launch({
      OMB_QDRANT_URL: service.url,
      OMB_QDRANT_API_KEY: "bearer-fixture",
      OMB_QDRANT_ACCESS_CLIENT_ID: "fixture-client.access",
      OMB_QDRANT_ACCESS_CLIENT_SECRET: "fixture-access-secret",
      OMB_QDRANT_COLLECTION: "agent-memory",
    });

    await callTool("recall_search", { query: "how do we deploy" });
    await callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });

    // The search may ride a cached verdict; the contribute re-probes first,
    // every time, because the write body names no collection (see the
    // caching block below).
    expect(service.seen.map((hit) => hit.path)).toEqual([
      "/health", "/recall/stats", "/recall/search",
      "/health", "/recall/stats", "/recall/contribute",
    ]);
    for (const hit of service.seen) {
      expect(hit.accessId).toBe("fixture-client.access");
      expect(hit.accessSecret).toBe("fixture-access-secret");
      // Alongside, not instead of — some deployments gate at the edge, some
      // at the origin, some at both.
      expect(hit.authorization).toBe("Bearer bearer-fixture");
    }
  });

  it("sends no Access headers when no service token is configured", async () => {
    const service = await startRecordingService((_req, res) => okJson(res));

    const { callTool } = launch({ OMB_QDRANT_URL: service.url, OMB_QDRANT_API_KEY: "bearer-fixture" });
    await callTool("recall_search", { query: "how do we deploy" });

    expect(service.seen).toHaveLength(1);
    expect(service.seen[0].accessId).toBeUndefined();
    expect(service.seen[0].accessSecret).toBeUndefined();
    expect(service.seen[0].authorization).toBe("Bearer bearer-fixture");
  });

  it("sends only the bearer when just one half of a service token is set", async () => {
    const service = await startRecordingService((_req, res) => okJson(res));

    const { callTool } = launch({
      OMB_QDRANT_URL: service.url,
      OMB_QDRANT_API_KEY: "bearer-fixture",
      OMB_QDRANT_ACCESS_CLIENT_ID: "fixture-client.access",
    });
    await callTool("recall_search", { query: "how do we deploy" });

    expect(service.seen[0].accessId).toBeUndefined();
    expect(service.seen[0].accessSecret).toBeUndefined();
  });

  it("says a login redirect means Access instead of reporting a parse failure", async () => {
    // The redirect target carries Access's own path marker
    // (/cdn-cgi/access/login/...), which is what a real Access gateway always
    // sends regardless of which host answers it — so this stays hermetic
    // (same origin as the stub, no live DNS/network dependency) while still
    // exercising the real "restrict redirects, then recognise" path a genuine Access
    // redirect takes.
    const service = await startRecordingService((req, res) => {
      if ((req.url ?? "").startsWith("/cdn-cgi/access/login/")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>Sign in with your identity provider to continue.</body></html>");
        return;
      }
      res.writeHead(302, { location: "/cdn-cgi/access/login/recall.example.com?kid=fixture" });
      res.end();
    });

    const { callTool } = launch({ OMB_QDRANT_URL: service.url, OMB_QDRANT_API_KEY: "bearer-fixture" });
    const text = await callTool("recall_search", { query: "how do we deploy" });

    expect(text).toContain("login page");
    expect(text).toContain("Cloudflare Access");
    expect(text).toContain("service token");
    // The old failure mode: the redirect got followed and the HTML came back
    // as an unreadable search error.
    expect(text).not.toMatch(/JSON|unexpected token/i);
  });
});

describe("Agent RAG proxy caches a verified collection and its search results", () => {
  // The proxy is a long-lived child process: one MCP session serves a whole
  // turn.  Before this, every search and every contribute re-ran the full
  // probe (GET /health then GET /recall/stats), so one search was three
  // round trips and the same two calls repeated for the life of the
  // session — even though the collection rarely changes under it.
  //
  // Rarely is not never, and only searches take that bet.  A contribution
  // re-probes every time: the write body names no collection, so the probe
  // is the only check that the corpus about to be written is still the
  // configured one.

  /** A stub that records every path, can be told to fail one route once, and
   * can be told to start reporting a different collection once a search has
   * been served — a service restarted under a running bot. */
  async function startService(options: { failSearchOnce?: boolean; collectionAfterSearch?: string } = {}) {
    const paths: string[] = [];
    let searches = 0;
    let owned = "agent-memory";
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      paths.push(url);
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (url === "/recall/search" && options.failSearchOnce && ++searches === 1) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "the corpus is rebuilding" }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          hits: [{ text: `a stored lesson for ${url}`, score: 0.9 }],
          mode: "hybrid",
          doc_id: "doc-7",
          collection: owned,
          points: 3,
          backend_ok: true,
        }));
        if (url === "/recall/search" && options.collectionAfterSearch) owned = options.collectionAfterSearch;
      });
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;
    const { callTool } = launch({ OMB_QDRANT_URL: `http://127.0.0.1:${port}`, OMB_QDRANT_COLLECTION: "agent-memory" });
    return { paths, callTool };
  }

  it("probes the collection once for a run of different searches", async () => {
    const service = await startService();

    await service.callTool("recall_search", { query: "how do we deploy" });
    await service.callTool("recall_search", { query: "who owns the board" });

    expect(service.paths).toEqual(["/health", "/recall/stats", "/recall/search", "/recall/search"]);
  });

  it("answers an identical search from memory, and a changed one from the service", async () => {
    const service = await startService();

    const first = await service.callTool("recall_search", { query: "how do we deploy" });
    const second = await service.callTool("recall_search", { query: "how do we deploy" });
    // A different limit is a different question, never a cache hit.
    await service.callTool("recall_search", { query: "how do we deploy", limit: 3 });

    expect(second).toBe(first);
    expect(first).toContain("a stored lesson");
    expect(service.paths).toEqual(["/health", "/recall/stats", "/recall/search", "/recall/search"]);
  });

  it("re-probes after a failed search, so a bad verdict never outlives the failure", async () => {
    const service = await startService({ failSearchOnce: true });

    const failed = await service.callTool("recall_search", { query: "how do we deploy" });
    const recovered = await service.callTool("recall_search", { query: "how do we deploy" });

    expect(failed).toContain("500");
    // Not cached as an answer, and the collection verdict went with it.
    expect(recovered).toContain("a stored lesson");
    expect(service.paths).toEqual([
      "/health", "/recall/stats", "/recall/search",
      "/health", "/recall/stats", "/recall/search",
    ]);
  });

  it("retires remembered searches once a contribution changes the corpus", async () => {
    const service = await startService();

    await service.callTool("recall_search", { query: "how do we deploy" });
    await service.callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });
    await service.callTool("recall_search", { query: "how do we deploy" });

    expect(service.paths).toEqual([
      "/health", "/recall/stats", "/recall/search",
      // The contribution re-probes, then its own fresh verdict covers the
      // search that follows it.
      "/health", "/recall/stats", "/recall/contribute", "/recall/search",
    ]);
  });

  it("re-probes before every contribution, so a write never rides a cached verdict", async () => {
    const service = await startService();

    await service.callTool("recall_search", { query: "how do we deploy" });
    await service.callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });
    await service.callTool("recall_contribute", {
      text: "A second lesson, also long enough to be a real contribution to the corpus.",
      category: "lesson",
    });

    expect(service.paths).toEqual([
      "/health", "/recall/stats", "/recall/search",
      "/health", "/recall/stats", "/recall/contribute",
      "/health", "/recall/stats", "/recall/contribute",
    ]);
  });

  it("refuses a contribution when the service has started owning a different collection", async () => {
    // The regression this pins: the contribute body carries no collection
    // name, so if a service restarts owning another corpus within the
    // verification TTL, a contribution that rode the search's cached verdict
    // landed in the wrong corpus and reported success.
    const service = await startService({ collectionAfterSearch: "someone-elses-memory" });

    const found = await service.callTool("recall_search", { query: "how do we deploy" });
    const refused = await service.callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });

    expect(found).toContain("a stored lesson");
    expect(refused).toContain("different collection");
    expect(refused).not.toMatch(/Successfully contributed|doc-7/);
    // The write never left the process: the probe ran and stopped it.
    expect(service.paths).toEqual(["/health", "/recall/stats", "/recall/search", "/health", "/recall/stats"]);
  });

  it("retires the cached verdict when recall_stats sees the corpus fail its own check", async () => {
    // recall_stats runs a probe of its own.  When that probe comes back not
    // ready — a collection mismatch, an unhealthy backend, a gate — whatever
    // an earlier search concluded is now known to be out of date, so it is
    // retired here too rather than left for the next search to ride.
    const service = await startService({ collectionAfterSearch: "someone-elses-memory" });

    const found = await service.callTool("recall_search", { query: "how do we deploy" });
    const reported = await service.callTool("recall_stats");
    const after = await service.callTool("recall_search", { query: "how do we deploy" });

    expect(found).toContain("a stored lesson");
    expect(reported).toContain("status check failed");
    // The identical search is no longer answerable from memory: it re-probed,
    // and the probe caught the collection that had changed underneath it.
    expect(after).not.toContain("a stored lesson");
    expect(after).toContain("different collection");
    expect(service.paths).toEqual([
      "/health", "/recall/stats", "/recall/search",
      "/health", "/recall/stats",
      "/health", "/recall/stats",
    ]);
  });
});

describe("recall_stats runs on the tool budget", () => {
  // recall_search and recall_contribute already got the 30 s tool budget;
  // recall_stats silently got the 12 s settings-probe budget because the
  // proxy called recallStatus without the second argument PR #437 added.  A
  // cold embedder would then fail the bot's stats call while the same corpus
  // answered its searches fine.
  //
  // This is asserted at the call site rather than by observation: the only
  // way to tell 12 s from 30 s from outside is to stall a stub past the
  // shorter deadline, and a 12-second wait in a serial suite costs more than
  // the bug does.
  //
  // The call site moved: #465 lifted the three recall tool bodies out of this
  // proxy into the shared server/recall-tools.ts, which the HTTP lane's
  // in-process tools now run too.  So this guards the budget for both lanes
  // rather than just the proxy's.
  const TOOLS_SRC = readFileSync(join(__dirname, "..", "recall-tools.ts"), "utf8");

  it("passes the tool budget explicitly to recallStatus", () => {
    const body = TOOLS_SRC.slice(TOOLS_SRC.indexOf("async function recallStatsWith("));
    const call = body.slice(body.indexOf("recallStatus("), body.indexOf(");", body.indexOf("recallStatus(")));

    expect(call).toContain("RECALL_TOOL_TIMEOUT_MS");
  });

  it("guards the guard: the two budgets are still different numbers", () => {
    // If these ever converge the assertion above proves nothing, and the
    // bug it pins would be invisible again.
    expect(RECALL_TOOL_TIMEOUT_MS).toBe(30_000);
    expect(RECALL_STATUS_TIMEOUT_MS).toBe(12_000);
  });
});

describe("Agent RAG proxy follows benign same-host redirects", () => {
  // The bug this guards against: a fetch made with `redirect: "manual"`
  // treats ANY 3xx as an identity gateway, so a plain http:// -> https://
  // upgrade (301) or a trailing-slash normalisation (308) on the operator's
  // own host got misdiagnosed as "behind Cloudflare Access — add a service
  // token" when the real fix was just the URL.  These follow the redirect
  // (matching the driver's `redirect: "follow"`) and land on the service's
  // real answer.

  it("follows a same-host 301 (e.g. an http:// -> https:// upgrade) instead of reporting an Access gate", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(301, { location: "/health-canonical" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collection: "agent-memory", points: 12, backend_ok: true, version: "1.0.0" }));
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;

    const { callTool } = launch({ OMB_QDRANT_URL: `http://127.0.0.1:${port}`, OMB_QDRANT_COLLECTION: "agent-memory" });
    const text = await callTool("recall_stats");

    expect(text).not.toMatch(/identity gateway|Cloudflare Access|login page/i);
    expect(text).toContain("agent-memory");
  });

  it("follows a same-host 308 trailing-slash normalisation instead of reporting an Access gate", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(308, { location: "/health/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ collection: "agent-memory", points: 34, backend_ok: true, version: "1.0.0" }));
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;

    const { callTool } = launch({ OMB_QDRANT_URL: `http://127.0.0.1:${port}`, OMB_QDRANT_COLLECTION: "agent-memory" });
    const text = await callTool("recall_stats");

    expect(text).not.toMatch(/identity gateway|Cloudflare Access|login page/i);
    expect(text).toContain("agent-memory");
  });

  it("recall_search and recall_contribute follow a benign same-host redirect instead of reporting an Access gate", async () => {
    // This is the bot path, not just the settings-panel probe above — the
    // same bug made every tool call through a redirected host look dead.
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const url = req.url ?? "";
        if (url === "/recall/search") {
          res.writeHead(307, { location: "/recall/search/canonical" });
          res.end();
          return;
        }
        if (url === "/recall/contribute") {
          res.writeHead(307, { location: "/recall/contribute/canonical" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (url === "/recall/search/canonical") {
          res.end(JSON.stringify({ hits: [{ text: "a stored lesson", score: 0.9 }], mode: "hybrid", collection: "agent-memory", points: 1, backend_ok: true }));
          return;
        }
        res.end(JSON.stringify({ doc_id: "doc-99", collection: "agent-memory", points: 1, backend_ok: true }));
      });
    });
    stub = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: listen() has resolved on a TCP socket, so address() is an
    // AddressInfo with a bound port, never null or a pipe name.
    const port = (server.address() as { port: number }).port;

    const { callTool } = launch({ OMB_QDRANT_URL: `http://127.0.0.1:${port}`, OMB_QDRANT_COLLECTION: "agent-memory" });
    const searchText = await callTool("recall_search", { query: "how do we deploy" });
    const contributeText = await callTool("recall_contribute", {
      text: "A lesson long enough to be a real contribution to the shared corpus.",
      category: "lesson",
    });

    expect(searchText).toContain("a stored lesson");
    expect(searchText).not.toMatch(/identity gateway|Cloudflare Access|login page/i);
    expect(contributeText).toContain("doc-99");
    expect(contributeText).not.toMatch(/identity gateway|Cloudflare Access|login page/i);
  });
});
