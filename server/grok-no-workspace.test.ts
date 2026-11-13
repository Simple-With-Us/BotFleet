// A Grok bot with its computers switched off gets no file tools.
//
// This branch briefly dropped `grok` from the `worksInWorkspace` exclusion on
// both lanes, on the reasoning that #442 had already given the other HTTP
// engines workspace file tools and Grok was merely left out.  That reasoning
// was wrong about what a workspace costs.  The workspace file tools —
// `read_file`, `write_file`, `edit_file` — are gated on `localComputer ||
// workspace` (server/tools/registry.ts:475), and their executor resolves an
// absolute path verbatim with no containment check (server/tools/computer.ts:26-28).
// So a workspace ALONE, with the bot's computers explicitly set to none, is
// enough to read any file the user can — `~/.botfleet/config.json` and the
// instance API keys inside it included — and `read_file` carries no approval
// record, so no card ever appears.
//
// That is already live on main for MiniMax and OpenAI-compat (board row
// 9998f9a9, P0).  Handing it to one more engine widens a known P0, so Grok
// joins the others only once those tools are confined to the workspace real
// path.  This test is what stops the exclusion being dropped again by
// somebody reading it as an oversight.
//
// The engine is `server/testing/fake-openai-server.ts` — the Grok driver's
// `config.url` points at it, so the real harness runs a real Grok turn over
// the loopback and the assertions read the exact request body it sent.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./testing/fake-openai-server.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

const says = (text: string) => ({
  kind: "sse" as const,
  frames: [`{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`, "[DONE]"],
});

interface CompletionBody {
  messages?: Array<{ role?: string; content?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
}

posixOnly("a Grok bot with no computer grant", () => {
  let child: ChildProcess;
  let engine: FakeOpenAiServer;
  let home: string;
  let base: string;
  let stderr = "";

  // SAFETY: the harness answers JSON on every route this test calls, and the
  // body shapes are asserted at the point of use.
  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const until = async <T,>(probe: () => Promise<T | null>, what: string, timeoutMs = 30_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = await probe();
      if (hit !== null && hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const botById = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === id);

  /** The last body the harness POSTed to the fake engine. */
  const lastCompletion = (): CompletionBody => {
    const rounds = engine.requests.filter((r) => r.url.includes("/chat/completions"));
    // SAFETY: the fake engine records the JSON body the harness POSTed, and
    // the caller has already waited for at least one round to run.
    return rounds[rounds.length - 1]!.body as CompletionBody;
  };

  beforeAll(async () => {
    engine = await startFakeOpenAiServer();
    home = mkdtempSync(join(tmpdir(), "omb-grok-no-workspace-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        instances: {
          grok: {
            driver: "grok",
            // `config.url` wins over the driver's default, and the fake
            // server's url already carries the /v1 the driver expects.
            config: { url: engine.url },
            // A placeholder: the fake engine never checks it, and this must
            // never be a real credential.
            environment: { XAI_API_KEY: "fake-key-for-tests" },
          },
        },
      }),
      { mode: 0o600 },
    );
    const port = await freePortBlock([0]);
    base = `http://127.0.0.1:${port}`;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if (await harnessReady(base)) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await engine?.close();
    await removeTempDir(home);
  });

  it(
    "is offered no file tools, because a workspace alone is an uncarded read of the whole disk",
    async () => {
      const created = await api("POST", "/api/bots");
      expect(created.status).toBe(201);
      const bot = created.body.bot;
      expect(
        (await api("PATCH", `/api/bots/${bot.id}`, {
          name: "Scribe",
          // Switched off deliberately.  This is the bot whose owner believes
          // it is sandboxed, so the workspace would be its only door to the
          // file tools — and that door has no lock on it yet.
          computers: [],
          modelSelection: { instanceId: "grok", model: "grok-4-fast" },
        })).status,
      ).toBe(200);

      engine.queueCompletion(says("Noted."));
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "remember my timezone" })).status).toBe(202);
      await until(async () => ((await botById(bot.id))?.busy === false ? true : null), "the grok turn");

      const sent = lastCompletion();
      const offered = (sent.tools ?? []).map((t) => t.function?.name);
      expect(offered).not.toContain("read_file");
      expect(offered).not.toContain("write_file");
      expect(offered).not.toContain("edit_file");
      // It did get a catalog — the assertion above is about which tools are
      // missing, not about a turn that failed to build one.
      expect(offered.length).toBeGreaterThan(0);

      // and the same ternary gates the memory and skills blocks, so their
      // absence is the second half of the same proof
      const system = (sent.messages ?? []).find((m) => m.role === "system")?.content ?? "";
      expect(system).not.toContain("MEMORY.md");
      expect(system).not.toContain("Imported skills");
    },
    60_000,
  );
});
