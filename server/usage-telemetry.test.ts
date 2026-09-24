// Usage telemetry ships no endpoint and no project names.
//
// Two things are being defended here. First, an install that has configured
// nothing must report that it has configured nothing — the status route used
// to name a fallback host whether or not anyone had opted in, which reads to
// a user as "my tokens are already going there". Second, project
// classification is the operator's list, not a list of somebody's repos
// baked into the binary.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseStoredConfig, usageIngestUrl, usageProjectRules, type AppConfig } from "./config.ts";
import { inferProject, inferProviderAndService, telemetry, UsageTelemetryManager, type UsageSettings } from "./telemetry.ts";
import { ActiveTurnOwners } from "./turn-safety.ts";

const ENV_KEYS = ["USAGE_MONITOR_INGEST_URL", "USAGE_MONITOR_INGEST_TOKEN", "USAGE_INGEST_TOKEN"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  telemetry.configure(null);
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

function withSettings(settings: UsageSettings) {
  telemetry.configure(() => settings);
}

describe("telemetry status when nothing is configured", () => {
  it("reports no URL at all — not a fallback endpoint", () => {
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.ingestUrl).toBeNull();
  });

  it("stays disabled and nameless with a URL but no token", () => {
    withSettings({ ingestUrl: "https://usage.example.com" });
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.ingestUrl).toBeNull();
  });

  it("stays disabled and nameless with a token but no URL", () => {
    withSettings({ ingestToken: "tok_abc" });
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(false);
    expect(status.ingestUrl).toBeNull();
  });

  it("names the operator's own endpoint once both halves are set", () => {
    withSettings({ ingestUrl: "https://usage.example.com/", ingestToken: "tok_abc" });
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.ingestUrl).toBe("https://usage.example.com/api/ingest/usage");
  });

  it("still honours the env fallback so existing installs keep working", () => {
    process.env.USAGE_MONITOR_INGEST_URL = "https://env.example.com";
    process.env.USAGE_MONITOR_INGEST_TOKEN = "tok_env";
    const status = telemetry.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.ingestUrl).toBe("https://env.example.com/api/ingest/usage");
  });

  it("prefers configured settings over the env fallback", () => {
    process.env.USAGE_MONITOR_INGEST_URL = "https://env.example.com";
    process.env.USAGE_MONITOR_INGEST_TOKEN = "tok_env";
    withSettings({ ingestUrl: "https://configured.example.com", ingestToken: "tok_cfg" });

    expect(telemetry.getStatus().ingestUrl).toBe("https://configured.example.com/api/ingest/usage");
  });
});

describe("project classification", () => {
  const rules = [
    { slug: "storefront", match: ["shop-web", "storefront"] },
    { slug: "billing", match: ["invoices"] },
  ];

  it("uses the configured rules, in order", () => {
    expect(inferProject("/work/shop-web", "Bot", undefined, rules)).toBe("storefront");
    expect(inferProject("/work/invoices-api", "Bot", undefined, rules)).toBe("billing");
  });

  it("matches on bot name and task title, not just the working directory", () => {
    expect(inferProject(null, "invoices bot", undefined, rules)).toBe("billing");
    expect(inferProject(null, "Bot", "rebuild the storefront", rules)).toBe("storefront");
  });

  it("takes the first matching rule when several could match", () => {
    const ordered = [
      { slug: "first", match: ["shared"] },
      { slug: "second", match: ["shared"] },
    ];
    expect(inferProject("/work/shared-thing", "Bot", undefined, ordered)).toBe("first");
  });

  it("falls back to the working directory basename with no rules configured", () => {
    expect(inferProject("/work/some-repo", "Bot")).toBe("some-repo");
    expect(inferProject("/work/some-repo", "Bot", undefined, [])).toBe("some-repo");
  });

  it("falls back to the basename when no rule matches", () => {
    expect(inferProject("/work/unrelated", "Bot", undefined, rules)).toBe("unrelated");
  });

  it("returns general when there is no working directory to derive from", () => {
    expect(inferProject(null, "Bot", "some task", rules)).toBe("general");
    expect(inferProject("/", "Bot", undefined, rules)).toBe("general");
  });

  it("ships no built-in project names", () => {
    // The classifier used to hardcode a specific set of repositories. Those
    // names must now resolve only through configuration.
    for (const name of ["congress-trade", "socratic-trade", "dealdex", "fleet-ops", "ai-fleet-coordinator"]) {
      expect(inferProject(`/work/${name}`, "Bot")).toBe(name);
      expect(inferProject("/work/plain", `${name} bot`, undefined, [])).toBe("plain");
    }
  });

  it("ignores rules with an empty slug or no match terms", () => {
    const sloppy = [
      { slug: "", match: ["work"] },
      { slug: "nomatch", match: [] },
      { slug: "real", match: ["work"] },
    ];
    expect(inferProject("/work/thing", "Bot", undefined, sloppy)).toBe("real");
  });
});

describe("telemetry probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    telemetry.configure(null);
  });

  it("refuses when the URL or token is missing", async () => {
    withSettings({ ingestUrl: "https://usage.example.com" });
    const result = await telemetry.probe();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/token/i);
    expect(result.ingestUrl).toBeNull();
  });

  it("posts a probe and reports success", async () => {
    withSettings({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://usage.example.com/api/ingest/usage");
      // SAFETY: this suite's own manager builds the headers as a plain record.
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok_abc");
      // SAFETY: the posted body is the v2 batch this manager just wrote, so
      // its producer id and events array are exactly the shape asserted below.
      const body = JSON.parse(String(init?.body)) as {
        producerId: string;
        events: Array<{ label: string; metadata?: { probe?: boolean } }>;
      };
      expect(body.producerId).toBe("botfleet");
      expect(body.events[0]?.label).toMatch(/connection test/i);
      expect(body.events[0]?.metadata?.probe).toBe(true);
      return new Response(
        JSON.stringify({ received: 1, persisted: 1, duplicates: 0, pruned: 0, rejected: 0 }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await telemetry.probe();
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.ingestUrl).toBe("https://usage.example.com/api/ingest/usage");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(telemetry.getStatus().lastAckAt).toBeTruthy();
    expect(telemetry.getStatus().lastError).toBeNull();
  });

  it("surfaces an HTTP 401 from Usage Monitor", async () => {
    withSettings({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));

    const result = await telemetry.probe();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
    expect(telemetry.getStatus().lastError).toMatch(/401/);
  });
});

describe("usage config", () => {
  it("round-trips ingest URL, token, and project rules through the schema", () => {
    const cfg = parseStoredConfig({
      usage: {
        ingestUrl: "https://usage.example.com/",
        ingestToken: "tok_abc",
        projects: [{ slug: "storefront", match: ["shop-web"] }],
      },
    });

    expect(usageIngestUrl(cfg)).toBe("https://usage.example.com");
    expect(cfg.usage?.ingestToken).toBe("tok_abc");
    expect(usageProjectRules(cfg)).toEqual([{ slug: "storefront", match: ["shop-web"] }]);
  });

  it("reports no ingest URL for an empty or non-absolute value", () => {
    expect(usageIngestUrl({})).toBeNull();
    expect(usageIngestUrl({ usage: {} })).toBeNull();
    expect(usageIngestUrl({ usage: { ingestUrl: "   " } })).toBeNull();
    expect(usageIngestUrl({ usage: { ingestUrl: "usage.example.com" } })).toBeNull();
  });

  it("drops project rules that could never match", () => {
    const cfg: AppConfig = {
      usage: {
        projects: [
          { slug: " ", match: ["x"] },
          { slug: "keep", match: [" x ", ""] },
          { slug: "drop", match: [] },
        ],
      },
    };
    expect(usageProjectRules(cfg)).toEqual([{ slug: "keep", match: ["x"] }]);
  });
});

describe("provider naming", () => {
  // Usage Monitor joins on its own provider canon (provider-identity.ts).
  // A raw instance id lands as its own provider row, which is how one
  // engine's spend ends up split across several rows nobody configured.
  it("maps every shipped engine to a Usage Monitor provider name", () => {
    const cases: Array<[driverKind: string, provider: string]> = [
      ["claudeAgent", "anthropic"],
      ["codex", "openai"],
      ["grokAgent", "xai"],
      ["grok", "xai"],
      ["antigravityAgent", "google-ai"],
      ["deepseekAgent", "deepseek"],
      ["kimiAgent", "moonshot"],
      ["cursorAgent", "cursor"],
      ["minimax", "minimax"],
      ["boxAgent", "box"],
      ["openrouter", "openrouter"],
    ];

    for (const [driverKind, provider] of cases) {
      expect(inferProviderAndService("instance-7", "some-model", driverKind).provider).toBe(provider);
    }
  });

  it("gives the ACP engines a name of their own instead of an instance id", () => {
    const cases: Array<[driverKind: string, provider: string]> = [
      ["droidAgent", "droid"],
      ["dshAgent", "dsh"],
      ["opencodeGo", "opencode"],
      ["qwenAgent", "qwen"],
      ["hermesAgent", "hermes"],
      ["piAgent", "pi"],
    ];

    for (const [driverKind, provider] of cases) {
      const result = inferProviderAndService("operator-named-instance", undefined, driverKind);
      expect(result.provider).toBe(provider);
      expect(result.provider).not.toBe("operator-named-instance");
      expect(result.provider).not.toBe("custom");
    }
  });

  it("does not claim an OpenAI-compatible instance is OpenAI", () => {
    const result = inferProviderAndService("openaiCompat", "llama-3.3-70b", "openai-compat");

    expect(result.provider).toBe("openai-compat");
    expect(result.service).toBe("llama-3.3-70b");
  });

  it("lets the model settle an OpenAI-compatible turn when it can", () => {
    expect(inferProviderAndService("openaiCompat", "deepseek-chat", "openai-compat").provider).toBe("deepseek");
  });

  it("prefers the engine over an instance id that reads like another provider", () => {
    // An operator is free to name an instance "claude-ish"; the engine that
    // actually ran the turn is not up for interpretation.
    expect(inferProviderAndService("claude-ish", "grok-4", "grokAgent").provider).toBe("xai");
  });

  it("falls back to the instance id only when nothing else names a provider", () => {
    expect(inferProviderAndService("homegrown", undefined).provider).toBe("homegrown");
    expect(inferProviderAndService("", undefined).provider).toBe("custom");
  });

  // An engine this table does not know is not canonical either, so running
  // it through `normaliseEngine` would only rename the operator's instance —
  // punctuation stripped, a trailing "agent" chopped — into a second Usage
  // Monitor provider row, splitting that engine's spend history in two and
  // breaking any provider-key binding set up against the old name.
  it("never rewrites an operator's own instance id into a mangled provider", () => {
    for (const instanceId of ["local_llm", "computer-2", "my.llm", "Home Lab"]) {
      expect(inferProviderAndService(instanceId, undefined).provider).toBe(instanceId);
      expect(inferProviderAndService(instanceId, undefined, "someFutureAgent").provider).toBe(instanceId);
    }
  });

  it("keeps two instances of one engine in a single provider row", () => {
    // The built-in `computer` instance and an operator's second Box desktop
    // run the same engine; the instance id is the only thing that differs,
    // and it must not be what decides the provider.
    expect(inferProviderAndService("computer", undefined, "boxAgent").provider).toBe("box");
    expect(inferProviderAndService("computer-2", undefined, "boxAgent").provider).toBe("box");
    expect(inferProviderAndService("whatever-the-operator-typed", "gpt-5", "boxAgent").provider).toBe("box");
  });
});

describe("ingest acknowledgement accounting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    telemetry.configure(null);
  });

  // A 200 is not the same as "kept".  Usage Monitor answers a batch it
  // validated but refused with 200 and a `rejected` count, and that used to
  // be filed as a clean send — the status card would read healthy while
  // every event was being dropped on the floor.
  it("counts rejected events as failures even though the POST returned 200", async () => {
    withSettings({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" });
    const before = telemetry.getStatus();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              schemaVersion: 2,
              received: 1,
              persisted: 0,
              duplicates: 0,
              pruned: 0,
              rejected: 1,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const result = await telemetry.probe();
    const after = telemetry.getStatus();

    expect(result.ok).toBe(false);
    expect(after.totalFailed).toBe(before.totalFailed + 1);
    expect(after.totalSent).toBe(before.totalSent);
    expect(after.lastError).toMatch(/rejected 1 of 1/);
    expect(after.lastAckAt).toBeTruthy();
  });

  it("treats a clean acknowledgement as a send and clears the last error", async () => {
    withSettings({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" });
    const before = telemetry.getStatus();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              schemaVersion: 2,
              received: 1,
              persisted: 1,
              duplicates: 0,
              pruned: 0,
              rejected: 0,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const result = await telemetry.probe();
    const after = telemetry.getStatus();

    expect(result.ok).toBe(true);
    expect(after.totalSent).toBe(before.totalSent + 1);
    expect(after.totalFailed).toBe(before.totalFailed);
    expect(after.lastError).toBeNull();
  });

  it("defaults the durable outbox under DATA_DIR so OMB_DATA_DIR isolates harnesses", () => {
    const source = readFileSync(new URL("./telemetry.ts", import.meta.url), "utf8");
    expect(source).toMatch(/join\(DATA_DIR,\s*"usage-telemetry-outbox\.json"\)/);
    expect(source).not.toMatch(/homedir\(\),\s*"\.botfleet",\s*"usage-telemetry-outbox\.json"/);
  });

  it("retains an ambiguous 2xx response as a failure instead of assuming delivery", async () => {
    withSettings({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" });
    const before = telemetry.getStatus();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));

    const result = await telemetry.probe();
    const after = telemetry.getStatus();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ambiguous acknowledgement/i);
    expect(after.totalFailed).toBe(before.totalFailed + 1);
    expect(after.totalSent).toBe(before.totalSent);
  });

  it("keeps a durable turn queued when a 2xx response has no receiver ACK counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "botfleet-telemetry-ack-"));
    const manager = new UsageTelemetryManager({
      enableOutbox: true,
      outboxPath: join(root, "outbox.json"),
      retryBaseMs: 60_000,
    });
    manager.configure(() => ({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 })));

    manager.trackTurn({
      botId: "bot_1",
      botName: "Scout",
      threadId: "thread_1",
      instanceId: "codex",
      modelId: "gpt-6-astra",
      driverKind: "codex",
      inputTokens: 10,
      outputTokens: 4,
    });
    await vi.waitFor(() => expect(manager.getStatus().totalFailed).toBeGreaterThan(0));

    expect(manager.getStatus().queuedBatches).toBe(1);
    expect(manager.getStatus().oldestQueuedAgeMs).not.toBeNull();
    await manager.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([400, 409] as const)("quarantines receiver HTTP %i and sends a later turn", async (status) => {
    const root = mkdtempSync(join(tmpdir(), "botfleet-telemetry-terminal-"));
    const path = join(root, "outbox.json");
    const manager = new UsageTelemetryManager({ enableOutbox: true, outboxPath: path });
    const posted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      posted.push(payload.events[0].eventId);
      if (posted.length === 1) return new Response("private receiver detail", { status });
      return new Response(JSON.stringify({
        received: payload.events.length,
        persisted: payload.events.length,
        duplicates: 0,
        pruned: 0,
        rejected: 0,
      }), { status: 202 });
    }));
    manager.configure(() => ({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" }));
    try {
      for (const threadId of ["poison-thread", "later-thread"]) {
        manager.trackTurn({
          botId: "bot_1", botName: "Scout", threadId, instanceId: "codex", modelId: "gpt-6-astra",
          driverKind: "codex", inputTokens: 10, outputTokens: 4,
        });
      }
      await vi.waitFor(() => expect(manager.getStatus()).toMatchObject({
        queuedBatches: 0,
        terminalQuarantinedBatches: 1,
        lastTerminalStatus: status,
        lastTerminalAt: expect.any(String),
        totalSent: 1,
      }));
      expect(posted).toHaveLength(2);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved.terminalQuarantine[0].status).toBe(status);
      expect(saved.terminalQuarantine[0].entry.batch.events[0].eventId).toBe(posted[0]);
      expect(JSON.stringify(saved)).not.toContain("private receiver detail");
      expect(JSON.stringify(saved)).not.toContain("tok_abc");
    } finally {
      await manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never copies a non-2xx receiver body into status or logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    withSettings({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private receiver detail", { status: 500 })));

    const result = await telemetry.probe();
    const rendered = JSON.stringify({ result, status: telemetry.getStatus(), logs: warn.mock.calls });

    expect(result.error).toBe("Usage Monitor returned HTTP 500");
    expect(rendered).not.toContain("private receiver detail");
    warn.mockRestore();
  });

  it("reports only an exception class for network failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    withSettings({ ingestUrl: "https://usage.example.com", ingestToken: "tok_abc" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("private network detail"); }));

    const result = await telemetry.probe();
    const rendered = JSON.stringify({ result, status: telemetry.getStatus(), logs: warn.mock.calls });

    expect(result.error).toBe("Usage Monitor dispatch failed (TypeError)");
    expect(rendered).not.toContain("private network detail");
    warn.mockRestore();
  });
});

// The payload arithmetic is checked in telemetry-payload.test.ts; what is
// checked here is that the harness hands `trackTurn` the right *engine*.
// `driverKind` is documented as the engine (`claudeAgent`, `codex`,
// `opencodeGo`) and is preferred over the instance-id heuristics precisely
// because an instance id is operator-chosen and an engine id is not.  Both
// call sites once passed `…modelSelection.instanceId`, which fed the
// operator's own text into provider canonicalisation and, before the
// fallback was tightened, renamed custom instances in Usage Monitor.
describe("harness telemetry wiring", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const indexSource = readFileSync(join(ROOT, "server", "index.ts"), "utf8");

  it("reports the engine that ran the turn, never the operator's instance id", () => {
    const fromEngine = indexSource.match(/driverKind:\s*event\.provider\b/g) ?? [];
    expect(fromEngine.length).toBe(2);
    expect(indexSource).not.toMatch(/driverKind:\s*\w+\.modelSelection\.instanceId/);
  });

  it("attributes instance and model usage to the per-turn selection", () => {
    expect(indexSource.match(/instanceId:\s*actualSelection\.instanceId\b/g)?.length).toBeGreaterThanOrEqual(2);
    expect(indexSource.match(/modelId:\s*actualSelection\.model\b/g)).toHaveLength(2);
    expect(indexSource).not.toMatch(/instanceId:\s*(?:bot|roomBot)\.modelSelection\.instanceId/);
    expect(indexSource).not.toMatch(/modelId:\s*(?:bot|roomBot)\.modelSelection\.model/);
  });

  it("passes settled latency to both 1:1 and room telemetry calls", () => {
    expect(indexSource.match(/latencyMs:\s*settledOwner\?\.latencyMs/g)).toHaveLength(2);
  });

  it("posts elapsed dispatch time and failure status in the Usage Monitor payload", async () => {
    let clock = 100;
    const owners = new ActiveTurnOwners(() => clock);
    const selection = { instanceId: "claude", model: "sonnet" };
    owners.claim("thread", { botId: "bot", selection, fallbackPolicy: selection });
    clock += 1_234;
    const settled = owners.settle("thread", "claude");
    const manager = new UsageTelemetryManager({ enableOutbox: false });
    manager.configure(() => ({ ingestUrl: "https://usage.example.com", ingestToken: "test-token" }));
    const post = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      received: 1,
      persisted: 1,
      duplicates: 0,
      pruned: 0,
      rejected: 0,
    }), { status: 200 }));
    try {
      manager.trackTurn({
        botId: "bot",
        botName: "Scout",
        threadId: "thread",
        instanceId: selection.instanceId,
        modelId: selection.model,
        inputTokens: 12,
        latencyMs: settled?.latencyMs,
        success: false,
        roomId: "room",
        roomName: "Research",
      });
      await vi.waitFor(() => expect(manager.getStatus().totalSent).toBe(1));
      const [, init] = post.mock.calls[0]!;
      const batch = JSON.parse(String(init?.body));
      expect(batch.events[0].metadata).toMatchObject({ latencyMs: 1_234, success: false, roomId: "room" });
    } finally {
      post.mockRestore();
      await manager.dispose();
    }
    expect(owners.settle("thread", "claude")).toBeUndefined();
  });
});
