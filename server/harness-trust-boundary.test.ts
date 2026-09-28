// The harness's own trust boundary, end to end: what may reach a mutating
// route, and on whose authority.
//
// These four findings all live at the front door, so they are pinned in one
// place against one booted harness rather than in four unit files:
//
//   1. Origin — a loopback HOST was not enough.  Any other web app on this
//      Mac (a dev server, a page a malicious package served) was a first-class
//      caller of every mutating route, because "loopback hostname" said
//      nothing about which port.
//   2. Content type — a `text/plain` POST is a CORS-SIMPLE request, so it
//      arrives with no preflight and no origin worth refusing; every mutating
//      route now requires JSON.
//   3. Peer identity — the boot comms token is handed to every bot, so
//      `/api/internal/*` believed whatever `fromBotId` and `depth` the body
//      claimed.  Each turn's proxy now carries a token bound to that bot and
//      that depth.
//   4. Voice provider — a save that names a provider is verified against that
//      provider, never silently rewritten to the default.
//
// The TTS endpoints are pointed at a local stub rather than the providers, so
// the test can say WHICH provider a key was verified against.  Everything else
// is a real harness with a temp HOME.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 28800 + Math.floor(Math.random() * 8_000);
const BASE = `http://127.0.0.1:${PORT}`;
/** vite's dev port, which the origin allowlist names so `pnpm dev` works. */
const DEV_UI_PORT = 5199;

describe("harness trust boundary", () => {
  let child: ChildProcess;
  let home: string;
  let claudeDump: string;
  let stderr = "";
  /** Every path the voice-key verification actually hit, in order. */
  const ttsChecks: string[] = [];
  let ttsStub: Server;
  let ttsStubPort = 0;

  /** SAFETY: only used to read a status line off a harness JSON response. */
  const safeJson = (text: string): any => {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  };

  /** A call into the harness.  `body` is JSON-encoded here, at the boundary,
   *  so nothing downstream has to guess whether it was a value or a string. */
  /** A request body: anything JSON can carry, encoded by `api` itself. */
  type JsonBody = string | number | boolean | null | JsonBody[] | { [key: string]: JsonBody };
  const api = async (
    method: string,
    path: string,
    body?: JsonBody,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> => {
    const requestHeaders = { ...headers } satisfies Record<string, string>;
    if (body !== undefined) requestHeaders["content-type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
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

  /** A raw POST, for the content-type family: no content-type is added. */
  const raw = async (
    path: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  };

  /** A request with a Host header this test chose. */
  const rawHost = (method: string, path: string, host: string): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: PORT, path, method, headers: { host } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text ? safeJson(text) : null }));
        },
      );
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-trust-test-"));
    claudeDump = join(home, "claude-dump.json");
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          // a full-auto engine whose fake CLI dumps the MCP config the driver
          // mounts, which is where a bot's scoped comms token lands
          claude: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: claudeDump },
            config: { cli: FAKE_CLAUDE, fullAuto: true },
          },
        },
      }),
    );

    // Both providers' verification endpoints point at one stub, so the test
    // can prove a key was checked against the provider the card selected and
    // not against the default.
    ttsStub = createServer((req, res) => {
      ttsChecks.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      // MiniMax's probe reads a `base_resp.status_code`; ElevenLabs' only
      // asks for a 2xx.  One stub answers both shapes.
      res.end(JSON.stringify({ base_resp: { status_code: 0, status_msg: "success" }, voices: [] }));
    });
    await new Promise<void>((resolve) => ttsStub.listen(0, "127.0.0.1", resolve));
    // SAFETY: `listen` has resolved, so the server is bound and `address()`
    // is a `AddressInfo` carrying the port it was given.
    ttsStubPort = (ttsStub.address() as AddressInfo).port;

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(PORT),
      MINIMAX_API_URL: `http://127.0.0.1:${ttsStubPort}`,
      OMB_ELEVENLABS_API: `http://127.0.0.1:${ttsStubPort}/v1`,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    // One instance is one CLI probe, but the machine may be carrying other
    // seats' work; 25s was tuned on an idle laptop and turned a booting
    // child into "the server never came up".
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
  }, 40_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  describe("origin", () => {
    it("refuses a non-loopback Host, which is the DNS-rebinding half", async () => {
      // `fetch` refuses to set Host (it is a forbidden header name), so this
      // one has to go out over node:http the way a rebinding page would.
      const res = await rawHost("GET", "/api/bots", "evil.example");
      expect(res.status).toBe(403);
      // and the same request naming the loopback host is served
      expect((await rawHost("GET", "/api/bots", `127.0.0.1:${PORT}`)).status).toBe(200);
    });

    it("refuses a page served from another loopback port", async () => {
      // The exact S9 case: a dev server on this Mac that is not BotFleet.
      for (const origin of [
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        // a rebinding page that names the harness's port but not its origin
        "http://127.0.0.1",
        // and a foreign scheme dressed up as loopback
        "file://127.0.0.1:8799",
      ]) {
        const res = await api("GET", "/api/bots", undefined, { origin });
        expect(res.status, origin).toBe(403);
      }
    });

    it("allows the harness's own origin and the dev renderer's, and a missing Origin", async () => {
      for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://127.0.0.1:${DEV_UI_PORT}`]) {
        const res = await api("GET", "/api/bots", undefined, { origin });
        expect(res.status, origin).toBe(200);
      }
      // curl, the CLIs, the phone through the companion and the test suites
      // all send no Origin at all, and must keep working.
      expect((await api("GET", "/api/bots")).status).toBe(200);
    });

    it("allows candidate UI shim ports (18799, 28799) on loopback", async () => {
      for (const origin of ["http://127.0.0.1:18799", "http://localhost:18799", "http://127.0.0.1:28799"]) {
        const res = await api("GET", "/api/bots", undefined, { origin });
        expect(res.status, origin).toBe(200);
      }
      // Mutating attachment upload from the UI shim origin succeeds
      const upload = await raw("/api/attachments", "dummy-bytes", {
        "content-type": "image/png",
        origin: "http://127.0.0.1:18799",
      });
      expect(upload.status).toBe(201);
    });
  });

  describe("content type", () => {
    it("refuses a text/plain POST on every mutating route family", async () => {
      const bot = (await api("POST", "/api/bots", { name: "Gate" })).body.bot;
      for (const [label, path, payload] of [
        ["create a bot", "/api/bots", { name: "Smuggled" }],
        ["send a message", `/api/bots/${bot.id}/messages`, { text: "run this" }],
        ["answer a card", `/api/bots/${bot.id}/respond`, { requestId: "r1", answer: "yes" }],
        ["start an update", "/api/update/run", { force: true }],
        ["save the config", "/api/config", { features: { summarizeToolCalls: false } }],
      ] as const) {
        const res = await raw(path, JSON.stringify(payload), { "content-type": "text/plain" });
        expect(res.status, label).toBe(415);
      }
    });

    it("still takes the binary upload, and still takes JSON", async () => {
      // The one route whose body is not JSON: the phone's photo/audio upload,
      // forwarded by the companion with its own content-type.
      const upload = await raw("/api/attachments", "not-json", { "content-type": "image/png" });
      expect(upload.status).not.toBe(415);
      // A bodyless mutating request has no content type to check.
      const stoppable = (await api("POST", "/api/bots", { name: "Stopper" })).body.bot;
      expect((await api("POST", `/api/bots/${stoppable.id}/interrupt`, {})).status).not.toBe(415);
      const bot = (await api("POST", "/api/bots", { name: "Json" })).body.bot;
      expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "Renamed" })).status).toBe(200);
    });
  });

  describe("peer identity", () => {
    /** The scoped token the harness just handed one bot's own proxy. */
    let grant = { token: "", botId: "" };

    beforeAll(async () => {
      const claude = (await api("GET", "/api/instances")).body.instances.find(
        (i: { instanceId: string }) => i.instanceId === "claude",
      );
      const bot = (await api("POST", "/api/bots", { name: "Peer" })).body.bot;
      await api("PATCH", `/api/bots/${bot.id}`, {
        modelSelection: { instanceId: "claude", model: claude.models.default },
      });
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "say hi" })).status).toBe(202);

      const deadline = Date.now() + 30_000;
      let mcpServers: Record<string, { env?: Record<string, string> }> | undefined;
      while (Date.now() < deadline) {
        if (existsSync(claudeDump)) {
          const dump = JSON.parse(readFileSync(claudeDump, "utf8"));
          mcpServers = dump?.mcpConfig?.mcpServers;
          if (mcpServers) break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const agents = Object.values(mcpServers ?? {}).find(
        (server) => server?.env?.OMB_COMMS_TOKEN !== undefined && server.env.OMB_BOT_ID !== undefined,
      );
      if (!agents) throw new Error(`no agents mount in the dumped MCP config. stderr:\n${stderr.slice(-2000)}`);
      // SAFETY: the `find` above only matches a mount whose `env` carries both
      // values as strings, and a match means they are present.
      const mountedEnv = agents.env!;
      grant = { token: mountedEnv.OMB_COMMS_TOKEN!, botId: mountedEnv.OMB_BOT_ID! };
      expect(grant.botId).toBe(bot.id);
      await api("POST", `/api/bots/${bot.id}/interrupt`, {});
    }, 60_000);

    it("refuses a token that claims to be another bot", async () => {
      const other = (await api("POST", "/api/bots", { name: "Victim" })).body.bot;
      const res = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: other.id, toBotId: grant.botId, message: "hi", depth: 0 },
        { authorization: `Bearer ${grant.token}` },
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/another bot/);
    });

    it("refuses a depth beyond the one the token was issued", async () => {
      // The turn that minted this token ran at depth 0; a depth-1 peer hop
      // is an escalation the caller was never granted.
      const res = await api(
        "POST",
        "/api/internal/ask-bot",
        { fromBotId: grant.botId, toBotId: grant.botId, message: "and again", depth: 1 },
        { authorization: `Bearer ${grant.token}` },
      );
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/depth/);
    });

    it("lets the same token speak for its own bot, and turns away another bot's name", async () => {
      // The positive half, on the one route that answers immediately: the
      // grant is for THIS bot, so this bot's own name stands and only another
      // name is refused.  (ask-bot is not the control — it dispatches a real
      // peer turn and this fixture has no second engine.)
      const other = (await api("POST", "/api/bots", { name: "Target" })).body.bot;
      const own = await api("GET", `/api/internal/agents?self=${grant.botId}`, undefined, {
        authorization: `Bearer ${grant.token}`,
      });
      expect(own.status).toBe(200);
      const otherName = await api("GET", `/api/internal/agents?self=${other.id}`, undefined, {
        authorization: `Bearer ${grant.token}`,
      });
      expect(otherName.status).toBe(403);
    });
  });

  describe("voice provider", () => {
    it("stores an ElevenLabs key as ElevenLabs and verifies it there", async () => {
      ttsChecks.length = 0;
      const saved = await api("PUT", "/api/config", { tts: { key: "ak_test_elevenlabs", provider: "elevenlabs" } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);

      // ElevenLabs verifies with `GET /voices` against its own API; the
      // default provider's `POST /v1/get_voice` must not have been called.
      expect(ttsChecks).toContain("GET /v1/voices");
      expect(ttsChecks.filter((entry) => entry.includes("get_voice"))).toEqual([]);

      const stored = (await api("GET", "/api/config")).body;
      expect(stored.tts.provider).toBe("elevenlabs");
    });

    it("verifies a MiniMax key against MiniMax", async () => {
      ttsChecks.length = 0;
      const saved = await api("PUT", "/api/config", { tts: { key: "ak_test_minimax", provider: "minimax" } });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(ttsChecks.some((entry) => entry.includes("get_voice"))).toBe(true);
      expect(ttsChecks.filter((entry) => entry.includes("voices"))).toEqual([]);
      expect((await api("GET", "/api/config")).body.tts.provider).toBe("minimax");
    });

    it("names back an unknown provider instead of falling back to a default", async () => {
      ttsChecks.length = 0;
      const res = await api("PUT", "/api/config", { tts: { key: "ak_test_nope", provider: "acme-voice" } });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/elevenlabs/);
      // and nothing was transmitted anywhere
      expect(ttsChecks).toEqual([]);
      expect((await api("GET", "/api/config")).body.tts.provider).toBe("minimax");
    });
  });
});
