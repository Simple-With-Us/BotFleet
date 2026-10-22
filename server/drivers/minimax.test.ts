import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, TurnToolHost } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { startFakeOpenAiServer } from "../testing/fake-openai-server.ts";
import { observeRuntimeEvent, resetSentryAiForTests, type SentryAiSink } from "../sentry-ai.ts";
import { costUsd } from "./chat-completions/pricing.ts";
import { VOLATILE_CONTEXT_NOTE_PREFIX } from "./prompt-split.ts";
import {
  decodeMinimaxConfig,
  isPricedMinimaxEndpoint,
  loadLocalMiniMaxConfig,
  MinimaxDriver,
  MINIMAX_PRICE_PER_MILLION,
} from "./minimax.ts";

/** One scripted SSE response, [DONE]-terminated. */
const sse = (...frames: string[]) =>
  new Response(frames.map((f) => `data: ${f}\n`).join("") + "data: [DONE]\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const TOOL_CALL_ROUND = [
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_bots","arguments":"{}"}}]}}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"ask_bot","arguments":"{\\"bot_id\\":\\"@peer\\",\\"task\\":\\"hi\\"}"}}]}}]}',
  '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
];

const answeringHost: TurnToolHost = {
  execute: async (call) => ({ kind: "result", content: `${call.name} ok` }),
};

// SAFETY: every call site passes an event already matched by
// `event.type === "turn.completed"` via `recorder.until`, which is exactly
// the RuntimeEvent variant carrying `cost`.
const costOf = (event: RuntimeEvent): number | null => (event as { cost: number | null }).cost;

/** A minimal Sentry sink that just remembers which spans opened and whether
 *  each one was ended — enough to prove span COUNT and lifecycle without
 *  standing up real Sentry. */
function recordingSink() {
  const spans: Array<{ op: string; ended: boolean }> = [];
  const sink: SentryAiSink = {
    setConversationId: () => undefined,
    startInactiveSpan: (opts) => {
      const rec = { op: opts.op, ended: false };
      spans.push(rec);
      return {
        setAttribute: () => undefined,
        setStatus: () => undefined,
        end: () => {
          rec.ended = true;
        },
      };
    },
    captureException: () => undefined,
    addBreadcrumb: () => undefined,
  };
  return { sink, spans };
}

describe("MinimaxDriver", () => {
  const saved = {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    key: process.env.MINIMAX_API_KEY,
    url: process.env.MINIMAX_BASE_URL,
  };
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "botfleet-minimax-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_BASE_URL;
  });

  afterEach(() => {
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.userProfile;
    if (saved.key === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.MINIMAX_BASE_URL;
    else process.env.MINIMAX_BASE_URL = saved.url;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetSentryAiForTests();
  });

  it("sits on the Cloud rail as MiniMax, honestly — this driver spawns no CLI", () => {
    expect(MinimaxDriver.metadata.displayName).toBe("MiniMax");
    expect(MinimaxDriver.metadata.access).toBeUndefined();
  });

  it("marks its install descriptor apiKeyOnly, so the setup UI never says install or sign in", () => {
    expect(MinimaxDriver.install?.apiKeyOnly).toBe(true);
  });

  it("offers only current official text models", () => {
    expect(MinimaxDriver.models).toEqual({
      default: "MiniMax-M3",
      options: [
        { id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
        { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800 },
      ],
    });
  });

  it("normalizes custom API roots", () => {
    expect(decodeMinimaxConfig({ url: "https://example.test/", apiKeyEnv: "CUSTOM_KEY" }))
      .toEqual({ url: "https://example.test/v1", urlSource: "instance" });
  });

  it("records WHERE the endpoint came from, not only what it resolved to", () => {
    // `url` is always filled in, so the resolved string alone cannot tell
    // "nothing configured" apart from "configured as the global host" — they
    // are byte-identical.  Provenance is decided here, where the three inputs
    // are still distinguishable, and nowhere else.
    expect(decodeMinimaxConfig({})).toEqual({ url: "https://api.minimax.io/v1", urlSource: "default" });
    expect(decodeMinimaxConfig({ url: "https://api.minimax.io/v1" }))
      .toEqual({ url: "https://api.minimax.io/v1", urlSource: "instance" });
    // The stamp instanceConfigs() writes on a url it resolved from the
    // workspace Settings row (server/config.ts's WORKSPACE_URL_SOURCE).
    expect(decodeMinimaxConfig({ url: "https://api.minimax.io/v1", urlSource: "workspace" }))
      .toEqual({ url: "https://api.minimax.io/v1", urlSource: "workspace" });
    // A blank url is not a choice, whatever rides beside it.
    expect(decodeMinimaxConfig({ url: "   ", urlSource: "workspace" }))
      .toEqual({ url: "https://api.minimax.io/v1", urlSource: "default" });
    process.env.MINIMAX_BASE_URL = "https://gateway.example.test/v1";
    expect(decodeMinimaxConfig({}))
      .toEqual({ url: "https://gateway.example.test/v1", urlSource: "environment" });
  });

  it("reads the official mmx-cli config and honors its region and model", () => {
    const dir = join(home, ".mmx");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      api_key: " local-key ",
      region: "cn",
      default_text_model: "MiniMax-M2.7-highspeed",
    }));

    expect(loadLocalMiniMaxConfig(home)).toEqual({
      apiKey: "local-key",
      url: "https://api.minimaxi.com/v1",
      defaultModel: "MiniMax-M2.7-highspeed",
    });
  });

  it("skips blank environment credentials and falls to the local mmx config, which DOES get probed on snapshot", async () => {
    const dir = join(home, ".mmx");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ api_key: "local-key" }));
    process.env.MINIMAX_API_KEY = "   ";
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify({ data: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const instance = await MinimaxDriver.create({
      // The RESERVED id: ~/.mmx/config.json is a machine-wide file, so only
      // the built-in connection may fall back to it.
      instanceId: "minimax",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "" },
    });

    // resolveMinimaxCredentials skipped the blank env values and landed on
    // the local config's key, so — unlike a truly keyless instance — there
    // IS a key to probe with, and snapshot() now does.
    await expect(instance.snapshot()).resolves.toMatchObject({ state: "available", authenticated: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { Authorization: "Bearer local-key" } });
    await instance.dispose();
  });

  it("never hands the workspace key to a connection the operator added", async () => {
    // process.env is process-wide and ~/.mmx/config.json is one file for the
    // whole machine, but a second MiniMax connection points at whatever
    // endpoint somebody typed in — the China host, a gateway, a reseller.
    // Falling through to either would send the workspace's real key to that
    // endpoint as a bearer token.  Same gate openai-compat.ts applies to its
    // own process.env lookup.
    const dir = mkdtempSync(join(tmpdir(), "mmx-scope-"));
    mkdirSync(join(dir, ".mmx"), { recursive: true });
    writeFileSync(join(dir, ".mmx", "config.json"), JSON.stringify({ api_key: "sentinel-workspace-local" }));
    process.env.MINIMAX_API_KEY = "sentinel-workspace-env";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const added = await MinimaxDriver.create({
      instanceId: "custom-minimax-china",
      displayName: "MiniMax China",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: {},
    });
    // No key from anywhere, so it reads unavailable and never probes — rather
    // than probing an arbitrary endpoint with the workspace credential.
    await expect(added.snapshot()).resolves.toMatchObject({ state: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(added.adapter.sendTurn({ threadId: "t", text: "hi" })).rejects.toThrow(/no MiniMax key/);
    await added.dispose();

    // Its own key still reaches it, through its isolated instance environment
    // — the ONLY channel a non-reserved instance has.
    const withOwnKey = await MinimaxDriver.create({
      instanceId: "custom-minimax-china",
      displayName: "MiniMax China",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "sentinel-its-own" },
    });
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ data: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    await expect(withOwnKey.snapshot()).resolves.toMatchObject({ state: "available" });
    const sent = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(sent["Authorization"]).toContain("sentinel-its-own");
    expect(JSON.stringify(sent)).not.toContain("sentinel-workspace");
    await withOwnKey.dispose();
  });

  it("never redirects a connection the operator added to the machine-wide mmx endpoint", async () => {
    // ~/.mmx/config.json is ONE file for the whole machine, so the endpoint
    // beside that key is a workspace-wide default.  A connection whose
    // operator deliberately typed the global URL matched DEFAULT_URL exactly,
    // so the fallback fired and re-pointed it at whatever region or custom
    // base_url that file names — with its own key along for the ride.
    mkdirSync(join(home, ".mmx"), { recursive: true });
    writeFileSync(
      join(home, ".mmx", "config.json"),
      JSON.stringify({ api_key: "sentinel-workspace-local", base_url: "https://profile.gateway.example/v1" }),
    );
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(
      JSON.stringify({ data: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const added = await MinimaxDriver.create({
      instanceId: "custom-minimax-global",
      displayName: "MiniMax Global",
      enabled: true,
      config: decodeMinimaxConfig({ url: "https://api.minimax.io/v1" }),
      environment: { MINIMAX_API_KEY: "sentinel-its-own" },
    });
    await expect(added.snapshot()).resolves.toMatchObject({ state: "available" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.minimax.io");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("profile.gateway.example");
    await added.dispose();

    // The reserved connection still follows that profile — reading it is the
    // whole reason the file is consulted at all.
    fetchMock.mockClear();
    const reserved = await MinimaxDriver.create({
      instanceId: "minimax",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: {},
    });
    await expect(reserved.snapshot()).resolves.toMatchObject({ state: "available" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("profile.gateway.example");
    await reserved.dispose();
  });

  it("keeps the reserved connection on a host the operator chose, even when that host IS the global default", async () => {
    // The gate used to ask "is config.url the default string?", which cannot
    // tell "nothing configured" apart from "pinned to the global host in
    // Settings" — the two are byte-identical.  So an operator who already
    // used the mmx CLI against the China region, and then typed the global
    // URL into Settings to pin the built-in connection, had every turn and
    // every probe silently re-pointed back at the China host with the
    // workspace key.
    mkdirSync(join(home, ".mmx"), { recursive: true });
    writeFileSync(
      join(home, ".mmx", "config.json"),
      JSON.stringify({ api_key: "sentinel-workspace-local", region: "cn" }),
    );
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(
      JSON.stringify({ data: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    // `urlSource: "workspace"` is the stamp instanceConfigs() writes on a url
    // it resolved from that Settings row.
    const pinned = await MinimaxDriver.create({
      instanceId: "minimax",
      displayName: "MiniMax",
      enabled: true,
      config: decodeMinimaxConfig({ url: "https://api.minimax.io/v1", urlSource: "workspace" }),
      environment: {},
    });
    await expect(pinned.snapshot()).resolves.toMatchObject({ state: "available" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.minimax.io");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("api.minimaxi.com");
    await pinned.dispose();

    // Nothing chose a host: the machine-wide profile still decides, which is
    // the whole reason that file is read at all.
    fetchMock.mockClear();
    const unset = await MinimaxDriver.create({
      instanceId: "minimax",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: {},
    });
    await expect(unset.snapshot()).resolves.toMatchObject({ state: "available" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.minimaxi.com");
    await unset.dispose();
  });

  it("tells each connection the remedy that can actually reach it", async () => {
    // MINIMAX_API_KEY and `mmx auth login` are workspace-wide, and a
    // non-reserved connection reads neither.  Offering them there sends the
    // operator somewhere that cannot fix anything.
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const added = await MinimaxDriver.create({
      instanceId: "custom-minimax-remedy",
      displayName: "MiniMax Gateway",
      enabled: true,
      config: decodeMinimaxConfig({ url: "https://gateway.example.test/v1" }),
      environment: {},
    });
    const addedSnapshot = await added.snapshot();
    expect(addedSnapshot).toMatchObject({ state: "unavailable" });
    const addedReason = (addedSnapshot as { reason: string }).reason;
    expect(addedReason).toContain("Settings");
    expect(addedReason).not.toContain("MINIMAX_API_KEY");
    expect(addedReason).not.toContain("mmx auth login");
    // Settings → API Keys has one row per WORKSPACE engine id, and by the
    // gate above that key can never reach an added connection.  There is no
    // per-instance key field anywhere today, so the only control that exists
    // is deleting and re-adding the connection.
    expect(addedReason).toContain("Engines");
    expect(addedReason).not.toContain("API Keys");
    await expect(added.adapter.sendTurn({ threadId: "t", text: "hi" })).rejects.toThrow(/Settings/);
    await added.dispose();

    // A rejected key on an added connection points at the same place.
    const rejected = await MinimaxDriver.create({
      instanceId: "custom-minimax-rejected",
      displayName: "MiniMax Gateway",
      enabled: true,
      config: decodeMinimaxConfig({ url: "https://gateway.example.test/v1" }),
      environment: { MINIMAX_API_KEY: "sentinel-its-own" },
    });
    const rejectedSnapshot = await rejected.snapshot();
    expect(rejectedSnapshot).toMatchObject({ state: "unavailable" });
    expect((rejectedSnapshot as { reason: string }).reason).toContain("Settings");
    expect((rejectedSnapshot as { reason: string }).reason).not.toContain("mmx auth login");
    expect((rejectedSnapshot as { reason: string }).reason).toContain("Engines");
    expect((rejectedSnapshot as { reason: string }).reason).not.toContain("API Keys");
    await rejected.dispose();

    // The built-in connection keeps the workspace remedies, which do reach it.
    const reserved = await MinimaxDriver.create({
      instanceId: "minimax",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: {},
    });
    const reservedSnapshot = await reserved.snapshot();
    expect(reservedSnapshot).toMatchObject({ state: "unavailable" });
    expect((reservedSnapshot as { reason: string }).reason).toContain("MINIMAX_API_KEY");
    await reserved.dispose();
  });

  it("a truly keyless instance (no env, no local config) reads unavailable without ever probing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const instance = await MinimaxDriver.create({
      instanceId: "minimax-keyless",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: {},
    });

    await expect(instance.snapshot()).resolves.toMatchObject({ state: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("probes GET /models and reports available for a valid key", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/models");
      return new Response(JSON.stringify({ data: [{ id: "MiniMax-M3" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-snapshot-ok",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });

    await expect(instance.snapshot()).resolves.toEqual({
      state: "available",
      authenticated: true,
      version: null,
      billing: "metered",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("a 401 on the models probe reads unavailable with a reason, not Available-until-a-turn-fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-snapshot-401",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "revoked" },
    });

    const result = await instance.snapshot();
    expect(result.state).toBe("unavailable");
    expect(result.reason).toMatch(/rejected|401/i);
    await instance.dispose();
  });

  it("a 429 on the models probe stays available but capped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-snapshot-429",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "capped" },
    });

    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
      quota: { capped: true },
    });
    await instance.dispose();
  });

  it("a network failure on the probe keeps the last good state instead of flipping to unavailable", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      const instance = await MinimaxDriver.create({
        instanceId: "minimax-snapshot-network",
        displayName: "MiniMax",
        enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      });

      const first = await instance.snapshot();
      expect(first.state).toBe("available");

      // past the 60s cache window, and the network is down this time
      fetchMock.mockImplementationOnce(() => Promise.reject(new Error("getaddrinfo ENOTFOUND")));
      await vi.advanceTimersByTimeAsync(61_000);
      const second = await instance.snapshot();

      expect(second).toEqual(first);
      await instance.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects the 60s probe cache — a second snapshot() inside the window does not re-fetch", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      vi.stubGlobal("fetch", fetchMock);
      const instance = await MinimaxDriver.create({
        instanceId: "minimax-snapshot-cache",
        displayName: "MiniMax",
        enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      });

      await instance.snapshot();
      await vi.advanceTimersByTimeAsync(30_000);
      await instance.snapshot();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(31_000);
      await instance.snapshot();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await instance.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the probe an 8s ceiling, and an aborted probe keeps the last good state rather than failing the instance", async () => {
    vi.useFakeTimers();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const requestedMs: number[] = [];
    let hangingController: AbortController | null = null;
    const timeoutStub = vi.fn((ms: number) => {
      requestedMs.push(ms);
      // The first probe wants a real, unfired signal; the second stands in
      // for one whose 8s ceiling has elapsed, which the test fires by hand
      // because AbortSignal.timeout does not run on vitest's fake clock.
      if (requestedMs.length === 1) return realTimeout(ms);
      hangingController = new AbortController();
      return hangingController.signal;
    });
    vi.stubGlobal("AbortSignal", Object.assign(Object.create(AbortSignal), AbortSignal, { timeout: timeoutStub }));
    try {
      const fetchMock = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
        const signal = init?.signal;
        if (signal && signal === hangingController?.signal) {
          return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("The operation was aborted due to timeout")));
          });
        }
        return new Response(JSON.stringify({ data: [{ id: "MiniMax-M3" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const instance = await MinimaxDriver.create({
        instanceId: "minimax-snapshot-timeout",
        displayName: "MiniMax",
        enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      });

      const first = await instance.snapshot();
      expect(first.state).toBe("available");
      expect(requestedMs[0]).toBe(8_000);

      // past the 60s cache window; this probe never answers
      await vi.advanceTimersByTimeAsync(61_000);
      const pending = instance.snapshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(requestedMs[1]).toBe(8_000);
      hangingController!.abort();

      await expect(pending).resolves.toEqual(first);
      await instance.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshModels replaces the static catalog from GET /models, off the same fetch snapshot() uses", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "MiniMax-M3" }, { id: "MiniMax-Next" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-refresh",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });

    await instance.refreshModels?.();
    expect(instance.models.options.map((o) => o.id)).toEqual(["MiniMax-M3", "MiniMax-Next"]);
    // a model already in the static catalog keeps its hand-written label
    expect(instance.models.options.find((o) => o.id === "MiniMax-M3")?.label).toBe("MiniMax M3");
    // a genuinely new model gets its id as the label rather than nothing
    expect(instance.models.options.find((o) => o.id === "MiniMax-Next")?.label).toBe("MiniMax-Next");

    // one call already spent by refreshModels; snapshot() reuses the cached
    // probe rather than firing a second GET /models
    await instance.snapshot();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("keeps the static catalog when the models fetch has never succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 500 })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-refresh-bad",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });

    await instance.refreshModels?.();
    expect(instance.models).toEqual({
      default: "MiniMax-M3",
      options: [
        { id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
        { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800 },
      ],
    });
    await instance.dispose();
  });

  it("streams content and usage with the MiniMax OpenAI contract", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
          "data: [DONE]\n",
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-turn",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "private prompt" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    const body = JSON.parse(String(request?.body));

    expect(body).toMatchObject({
      model: "MiniMax-M3",
      stream: true,
      reasoning_split: true,
      stream_options: { include_usage: true },
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await instance.dispose();
  });

  // Coverage for PR 625 (unattended turns get the 900s wall-clock budget as
  // their per-request ceiling instead of the 180s interactive one) and its
  // follow-up stall guard (STREAM_IDLE_TIMEOUT_MS), added on review — the
  // original PR shipped with no test proving either the widened ceiling or
  // its failure mode. All three use fake timers so a 900s-scale budget
  // does not cost 900s of real wall-clock test time.

  it("gives an unattended turn a per-request ceiling wide enough for a slow-but-live stream to outlive the 180s interactive one", async () => {
    vi.useFakeTimers();
    try {
      const enc = new TextEncoder();
      const fetchMock = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "slow " } }] })}\n`));
            // Two gaps (90s, 100s) that each stay under the 120s idle
            // guard, but sum to more than the 180s interactive ceiling —
            // isolating the widened per-request ceiling from the idle
            // guard this test is deliberately NOT exercising.
            setTimeout(() => {
              controller.enqueue(
                enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "reasoning" } }] })}\n`),
              );
            }, 90_000);
            setTimeout(() => {
              controller.enqueue(
                enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n`),
              );
              controller.enqueue(enc.encode("data: [DONE]\n"));
              controller.close();
            }, 190_000);
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const instance = await MinimaxDriver.create({
        instanceId: "minimax-unattended-slow",
        displayName: "MiniMax",
        enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      });
      const recorder = recordEvents(instance.adapter);

      await instance.adapter.sendTurn({ threadId: "thread-unattended-slow", text: "hi", unattended: true });
      const completedPromise = recorder.until((event) => event.type === "turn.completed", 1_000_000);
      await vi.advanceTimersByTimeAsync(200_000);
      const completed = await completedPromise;

      expect(completed).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 7, output: 3 } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(0);
      recorder.stop();
      await instance.dispose();
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("still fails an interactive (attended) turn at the 180s ceiling — the widened budget never applies without turn.unattended", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Truly silent until the round's own timer aborts it — real
            // fetch/undici would reject the pending read the same way once
            // `init.signal` aborts; this mock wires that up explicitly
            // since it never touches the network.
            init?.signal?.addEventListener("abort", () => {
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            });
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const instance = await MinimaxDriver.create({
        instanceId: "minimax-attended-ceiling",
        displayName: "MiniMax",
        enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      });
      const recorder = recordEvents(instance.adapter);

      // No `unattended` — this is the interactive path.
      await instance.adapter.sendTurn({ threadId: "thread-attended-ceiling", text: "hi" });
      const completedPromise = recorder.until((event) => event.type === "turn.completed", 1_000_000);
      const errorPromise = recorder.until((event) => event.type === "runtime.error", 1_000_000);
      await vi.advanceTimersByTimeAsync(180_000);
      const [completed, error] = await Promise.all([completedPromise, errorPromise]);

      expect(error).toMatchObject({ message: "the model did not answer within 180s" });
      expect(completed).toMatchObject({ ok: false, stopReason: "timeout" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      recorder.stop();
      await instance.dispose();
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("fails a stalled unattended MiniMax stream via the idle guard long before the 900s ceiling, and retries it like any other transient timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => {
        // Truly silent forever: never enqueues, never closes, never
        // errors.  Only STREAM_IDLE_TIMEOUT_MS explains this test settling
        // — the round's own ceiling here is 900s, far later than anything
        // this test advances to.
        const stream = new ReadableStream<Uint8Array>({ start() {} });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const instance = await MinimaxDriver.create({
        instanceId: "minimax-unattended-stall",
        displayName: "MiniMax",
        enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      });
      const recorder = recordEvents(instance.adapter);

      await instance.adapter.sendTurn({ threadId: "thread-unattended-stall", text: "hi", unattended: true });
      const completedPromise = recorder.until((event) => event.type === "turn.completed", 1_000_000);
      // 3 attempts x 120s idle guard, plus ~4s of backoff between them —
      // comfortably under the 900s wall-clock ceiling this is proving the
      // turn never has to wait for.
      await vi.advanceTimersByTimeAsync(500_000);
      const completed = await completedPromise;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.reason)).toEqual([
        "timeout",
        "timeout",
      ]);
      expect(completed).toMatchObject({ ok: false, stopReason: "error" });
      const error = recorder.events.find((e) => e.type === "runtime.error");
      expect(error).toMatchObject({ message: expect.stringContaining("MiniMax stream timed out") });
      recorder.stop();
      await instance.dispose();
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("reports a bodyless stream clearly and releases the turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-empty",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const error = await recorder.until((event) => event.type === "runtime.error");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(error).toMatchObject({ message: "MiniMax returned no response body" });
    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(instance.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });

  it("a 401 from chat/completions settles error:invalid_credentials with a setup chip, not a red chip mid-turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid api key", { status: 401 })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-401",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "revoked" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    const error = await recorder.until((event) => event.type === "runtime.error");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(error).toMatchObject({ setup: true });
    expect(completed).toMatchObject({ ok: false, stopReason: "error:invalid_credentials" });
    recorder.stop();
    await instance.dispose();
  });

  it("a 502 from chat/completions settles error:upstream_outage after three attempts, so the fallback chain is consulted", async () => {
    // A 502 is retried now — but a PERSISTENT one must still reach the
    // same terminal classification it always did, or model-fallback.ts
    // never learns the upstream is out.
    const fetchMock = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-502",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "error:upstream_outage" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.attempt)).toEqual([1, 2]);
    // still ONE terminal event and ONE error chip across all three tries
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(1);
    recorder.stop();
    await instance.dispose();
  }, 30_000);

  it("rides out a 502 on the wire and settles the turn the retry answered", async () => {
    // The end-to-end shape of the same policy: a real socket, a real
    // non-2xx response, and a retry that re-sends a byte-identical body.
    const server = await startFakeOpenAiServer();
    try {
      server.queueCompletion({ kind: "json", status: 502, body: { error: "bad gateway" } });
      server.queueCompletion({
        kind: "sse",
        frames: [
          JSON.stringify({ choices: [{ delta: { content: "recovered" } }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } }),
          "[DONE]",
        ],
      });
      const instance = await MinimaxDriver.create({
        instanceId: "minimax-wire-retry",
        displayName: "MiniMax",
        enabled: true,
        config: decodeMinimaxConfig({ url: server.url }),
        environment: { MINIMAX_API_KEY: "secret" },
      });
      const recorder = recordEvents(instance.adapter);

      await instance.adapter.sendTurn({ threadId: "thread-wire-retry", text: "hi" });
      const completed = await recorder.until((event) => event.type === "turn.completed");

      // the usage that counts is the attempt that worked
      expect(completed).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 11, output: 4 } });
      const posts = server.requests.filter((r) => r.method === "POST");
      expect(posts).toHaveLength(2);
      // the retry re-sends the same prefix — the model sees one turn, not
      // a transcript that grew a round while nobody was looking
      expect(posts[1].body).toEqual(posts[0].body);
      expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
      expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(1);
      recorder.stop();
      await instance.dispose();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("rides out a real socket that closes before the first frame", async () => {
    // The finding this test exists for: a provider that accepts the
    // request, sends a 200 SSE head and then vanishes.  No mock — a real
    // socket destroyed mid-body, so Node's own fetch produces the actual
    // `TypeError: terminated` / `UND_ERR_SOCKET` shape rather than a
    // hand-built stand-in.  Nothing was published, so the replay is safe.
    const server = await startFakeOpenAiServer();
    try {
      server.queueCompletion({ kind: "close" });
      server.queueCompletion({
        kind: "sse",
        frames: [
          JSON.stringify({ choices: [{ delta: { content: "recovered" } }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }),
          "[DONE]",
        ],
      });
      const instance = await MinimaxDriver.create({
        instanceId: "minimax-wire-close",
        displayName: "MiniMax",
        enabled: true,
        config: decodeMinimaxConfig({ url: server.url }),
        environment: { MINIMAX_API_KEY: "secret" },
      });
      const recorder = recordEvents(instance.adapter);

      await instance.adapter.sendTurn({ threadId: "thread-wire-close", text: "hi" });
      const completed = await recorder.until((event) => event.type === "turn.completed");

      expect(completed).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 9, output: 2 } });
      expect(server.requests.filter((r) => r.method === "POST")).toHaveLength(2);
      expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => e.reason)).toEqual(["connection_reset"]);
      expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
      expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(1);
      recorder.stop();
      await instance.dispose();
    } finally {
      await server.close();
    }
  }, 30_000);

  it("never retries a stream that already showed the person text", async () => {
    // The duplicate-output hazard, on the wire: one delta reaches the bus
    // and THEN the socket dies.  Retrying would replay "half an " on top
    // of itself.
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "half an " } }] })}\n\n`),
            );
            setTimeout(() => controller.error(new Error("connection reset by peer")), 5);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-partial",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread-partial", text: "hi" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    // the partial text stays on the bus, and nothing replayed it
    expect(recorder.events.filter((e) => e.type === "content.delta").map((e) => e.delta)).toEqual(["half an "]);
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(0);
    expect(calls).toBe(1);
    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    recorder.stop();
    await instance.dispose();
  }, 20_000);

  it("forwards turn.tools to the API in OpenAI function-calling shape", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-tools",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "list my bots",
      tools: [
        {
          name: "list_bots",
          description: "List every bot in the fleet.",
          parameters: {
            type: "object",
            properties: { section: { type: "string" } },
            required: [],
          },
        },
        {
          name: "ask_bot",
          description: "Delegate a subtask to another bot.",
          parameters: { type: "object" },
        },
      ],
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "list_bots",
          description: "List every bot in the fleet.",
          parameters: {
            type: "object",
            properties: { section: { type: "string" } },
            required: [],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "ask_bot",
          description: "Delegate a subtask to another bot.",
          parameters: { type: "object" },
        },
      },
    ]);
    expect(body.tools).toHaveLength(2);
    recorder.stop();
    await instance.dispose();
  });

  it("streams tool_call deltas as item.started so steps render in the transcript", async () => {
    // Round 1 asks for a tool, round 2 answers.  The old driver settled the
    // TURN on round 1 with a `tool_calls: …` stop reason and left the bot
    // busy behind it; the loop keeps one turn open across both rounds.
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      round += 1;
      return round === 1
        ? sse(
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_bots","arguments":""}}]}}]}',
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"section\\":\\"ops\\"}"}}]}}]}',
            '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":""}}]}}]}',
          )
        : sse('{"choices":[{"delta":{"content":"two bots"}}]}');
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-tool-stream",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "list ops bots",
      tools: [{ name: "list_bots" }],
      toolHost: answeringHost,
    });
    const started = await recorder.until((event) => event.type === "item.started" && event.itemType === "tool");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(started).toMatchObject({
      itemId: "call_1",
      title: "list_bots",
    });
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn" });
    // the row the streamed chip opened is closed by the host's real outcome,
    // never by the driver asserting ok for work it did not do
    expect(recorder.events.filter((e) => e.type === "item.started")).toHaveLength(1);
    recorder.stop();
    await instance.dispose();
  });

  it("keeps the first id and name for a tool call instead of letting a later chunk overwrite it", async () => {
    // openai-compat.ts's fix and comment: a provider that repeats the id
    // and name on a later chunk for the same call must not clobber the
    // value the first chunk already established, or a fragmented/corrupted
    // resend truncates the name and breaks the match to the item.started
    // step that already opened under the original id.
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      round += 1;
      return round === 1
        ? new Response(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"list_bots","arguments":"{\\"sec"}}]}}]}\n' +
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stale","function":{"name":"list_b","arguments":"tion\\":\\"ops\\"}"}}]}}]}\n' +
            'data: [DONE]\n',
            { status: 200, headers: { "content-type": "text/event-stream" } },
          )
        : sse('{"choices":[{"delta":{"content":"done"}}]}');
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-tool-first-write-wins",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "list ops bots",
      tools: [{ name: "list_bots" }],
      toolHost: answeringHost,
    });
    await recorder.until((event) => event.type === "turn.completed");

    const started = recorder.events.filter((e) => e.type === "item.started" && e.itemType === "tool");
    const completedSteps = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ itemId: "call_a", title: "list_bots" });
    // the settled step must key on the SAME id the step opened under, or
    // the transcript row it belongs to can never be found
    expect(completedSteps).toHaveLength(1);
    expect(completedSteps[0]).toMatchObject({ itemId: "call_a", ok: true, arguments: '{"section":"ops"}' });
    recorder.stop();
    await instance.dispose();
  });

  it("flushes a final data: frame with no trailing newline instead of dropping it", async () => {
    // The frame carrying usage (stream_options.include_usage) can arrive as
    // the last thing the server writes before closing the connection, with
    // no terminating newline after it — the buffer must still be flushed
    // when the reader reports `done`, or this usage is silently lost.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-trailing-frame",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hi" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 9, output: 4 } });
    recorder.stop();
    await instance.dispose();
  });

  it("runs the tool loop inside sendTurn: one terminal event, summed usage, results in call order", async () => {
    const bodies: any[] = [];
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      round += 1;
      return round === 1
        ? sse(...TOOL_CALL_ROUND)
        : sse(
            '{"choices":[{"delta":{"content":"here you go"}}]}',
            '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
          );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-loop",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "who is around?",
      tools: [{ name: "list_bots" }, { name: "ask_bot" }],
      toolHost: answeringHost,
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    // ONE terminal event for the whole user turn, with the whole turn's cost
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(completed).toMatchObject({ ok: true, stopReason: "end_turn", usage: { input: 17, output: 8 } });
    // and nothing on the bus carries the old inner-round convention
    expect(
      recorder.events.filter(
        (e) => e.type === "turn.completed" && String(e.stopReason ?? "").startsWith("tool_calls:"),
      ),
    ).toHaveLength(0);

    // round 2 re-sends round 1's prefix byte for byte and appends the
    // assistant call plus one tool message per call, in CALL order
    expect(bodies).toHaveLength(2);
    expect(bodies[1].messages.slice(0, bodies[0].messages.length)).toEqual(bodies[0].messages);
    expect(bodies[1].messages.slice(-3)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "list_bots", arguments: "{}" } },
          {
            id: "call_2",
            type: "function",
            function: { name: "ask_bot", arguments: '{"bot_id":"@peer","task":"hi"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "list_bots ok" },
      { role: "tool", tool_call_id: "call_2", content: "ask_bot ok" },
    ]);

    const toolRows = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(toolRows).toHaveLength(2);
    expect(toolRows.every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(instance.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });

  it("Stop settles a turn that is sitting inside a tool call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse(...TOOL_CALL_ROUND)));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-stop",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);
    let running: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      running = resolve;
    });

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "ask the peer",
      tools: [{ name: "ask_bot" }],
      // a tool that never returns — the window where Stop used to be a
      // silent no-op
      toolHost: { execute: async () => (running(), new Promise(() => undefined)) },
    });
    await started;
    await instance.adapter.interruptTurn("thread");
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    // an interrupt is a decision, not a failure — no red chip
    expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
    expect(instance.adapter.hasSession("thread")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });

  it("rejects a bad dispatch synchronously, so startTurn's own recovery runs in milliseconds", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
    ));
    const keyless = await MinimaxDriver.create({
      instanceId: "minimax-nokey",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: {},
    });
    await expect(keyless.adapter.sendTurn({ threadId: "thread", text: "hi" })).rejects.toThrow(/no MiniMax key/);
    await keyless.dispose();

    const instance = await MinimaxDriver.create({
      instanceId: "minimax-busy",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    // sendTurn resolves at DISPATCH — the loop runs detached, the way every
    // CLI driver's turn does
    await instance.adapter.sendTurn({ threadId: "thread", text: "first" });
    await expect(instance.adapter.sendTurn({ threadId: "thread", text: "second" })).rejects.toThrow(
      /already running/,
    );
    await instance.dispose();
  });

  it("streams reasoning separately and completes only actual assistant text", async () => {
    // MiniMax sends reasoning_split: true on every request; before this fix
    // the driver read no reasoning field at all on any path.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n' +
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n' +
      "data: [DONE]\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-reasoning-stream",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "reasoning-thread", text: "question" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "content.delta", streamKind: "reasoning_text", delta: "thinking" }),
      expect.objectContaining({ type: "content.delta", streamKind: "assistant_text", delta: "answer" }),
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "answer" }),
    ]));
    expect(recorder.events).not.toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "thinking" }),
    );
    recorder.stop();
    await instance.dispose();
  });

  it("falls back to reasoning_content when assistant text is empty, so an all-reasoning reply is not an empty turn", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"thinking through the problem"}}]}\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n' +
      "data: [DONE]\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-reasoning-fallback",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread-rf", text: "prompt" });
    const item = await recorder.until((e) => e.type === "item.completed");
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(item).toMatchObject({
      type: "item.completed",
      itemType: "assistant_text",
      text: "thinking through the problem",
    });
    expect(completed).toMatchObject({ ok: true, usage: { input: 10, output: 5 } });
    recorder.stop();
    await instance.dispose();
  });

  it("uses reasoning as a generateText fallback when normal content is whitespace (non-stream path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "  ", reasoning_content: "usable result" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-reasoning-nonstream",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });

    await expect(instance.generateText?.("question")).resolves.toBe("usable result");
    await instance.dispose();
  });

  it("reports usage the stream already showed even when the request fails mid-stream", async () => {
    // A request timeout or upstream 5xx after several chunks previously
    // reported zero usage on the failure path, hiding real spend on a long
    // turn that happened to fail at the end.
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9}}\n'),
          );
          return;
        }
        controller.error(new Error("stream exploded"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-usage-on-failure",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread-fail", text: "hi" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "error", usage: { input: 20, output: 9 } });
    recorder.stop();
    await instance.dispose();
  });
  it("has a real price row for every model in its own catalog", () => {
    for (const option of MinimaxDriver.models.options) {
      expect(Object.prototype.hasOwnProperty.call(MINIMAX_PRICE_PER_MILLION, option.id)).toBe(true);
    }
  });

  it("prices a settled turn from its real usage, at the M3 ≤512K-token rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"here you go"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":50000}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-price",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 100_000, output: 50_000 } });
    // (100,000 @ $0.30/M) + (50,000 @ $1.20/M) = $0.03 + $0.06 = $0.09
    expect(costOf(completed)).toBeCloseTo(0.09, 10);
    expect(costOf(completed)).toBe(
      costUsd({ input: 100_000, output: 50_000 }, MINIMAX_PRICE_PER_MILLION, "MiniMax-M3"),
    );
    recorder.stop();
    await instance.dispose();
  });

  it("reads prompt_tokens_details.cached_tokens into cachedInput and bills it at the cache rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"here you go"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":10000,"prompt_tokens_details":{"cached_tokens":40000}}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-cache",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({
      ok: true,
      usage: { input: 100_000, output: 10_000, cachedInput: 40_000 },
    });
    // 60,000 uncached @ $0.30/M + 40,000 cached @ $0.06/M + 10,000 out @ $1.20/M
    // = $0.018 + $0.0024 + $0.012 = $0.0324
    expect(costOf(completed)).toBeCloseTo(0.0324, 10);
    recorder.stop();
    await instance.dispose();
  });

  it("returns a null cost — never 0 — for a model outside the priced catalog, even with real usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-unpriced-model",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hi", model: "MiniMax-Unreleased" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 100, output: 50 } });
    expect(costOf(completed)).toBeNull();
    recorder.stop();
    await instance.dispose();
  });

  it("prices the terminal event on the ERROR path too, from the usage a successful earlier round already reported", async () => {
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      round += 1;
      if (round === 1) return sse(...TOOL_CALL_ROUND);
      throw new Error("network down");
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-error-cost",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "who is around?",
      tools: [{ name: "list_bots" }, { name: "ask_bot" }],
      toolHost: answeringHost,
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    // TOOL_CALL_ROUND's own usage: prompt_tokens: 10, completion_tokens: 5
    expect(completed).toMatchObject({ ok: false, stopReason: "error", usage: { input: 10, output: 5 } });
    expect(costOf(completed)).toBeCloseTo(
      costUsd({ input: 10, output: 5 }, MINIMAX_PRICE_PER_MILLION, "MiniMax-M3")!,
      12,
    );
    recorder.stop();
    await instance.dispose();
  });

  it("knows which endpoints its published rates actually describe", () => {
    expect(isPricedMinimaxEndpoint("https://api.minimax.io/v1")).toBe(true);
    expect(isPricedMinimaxEndpoint("https://api.minimaxi.com/v1")).toBe(true);
    // case and a trailing slash are the same endpoint
    expect(isPricedMinimaxEndpoint("https://API.MiniMax.io/v1/")).toBe(true);
    // a gateway, a reseller, a self-hosted deployment — none of them
    // necessarily bills at MiniMax's own tariff
    expect(isPricedMinimaxEndpoint("https://gateway.internal.example/v1")).toBe(false);
    expect(isPricedMinimaxEndpoint("https://api.minimax.io.evil.example/v1")).toBe(false);
    expect(isPricedMinimaxEndpoint("not a url")).toBe(false);
  });

  it("reports a null cost — never MiniMax's own tariff — for a turn against a custom endpoint", async () => {
    // config.url and MINIMAX_BASE_URL are supported overrides for a
    // gateway or proxy whose billing this driver knows nothing about, and
    // a finite cost is stored downstream as real spend.
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":50000}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-gateway",
      displayName: "MiniMax",
      enabled: true,
      config: decodeMinimaxConfig({ url: "https://gateway.internal.example" }),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    // the usage is real and still reported; only the price is unknown
    expect(completed).toMatchObject({ ok: true, usage: { input: 100_000, output: 50_000 } });
    expect(costOf(completed)).toBeNull();
    recorder.stop();
    await instance.dispose();
  });

  it("still prices a turn against MiniMax's own China endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sse(
        '{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":50000}}',
      ),
    ));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-cn",
      displayName: "MiniMax",
      enabled: true,
      config: decodeMinimaxConfig({ url: "https://api.minimaxi.com" }),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread", text: "hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(costOf(completed)).toBeCloseTo(0.09, 10);
    recorder.stop();
    await instance.dispose();
  });

  it("routes generateText (titles, summaries) through the highspeed utility model, not models.default", async () => {
    let body: any;
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "a title" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-utility-model",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });

    const text = await instance.generateText?.("Summarize this thread in five words.");

    expect(text).toBe("a title");
    expect(body.model).toBe("MiniMax-M2.7-highspeed");
    expect(body.model).not.toBe(MinimaxDriver.models.default);
    await instance.dispose();
  });

  // withChatSpan's OWN default sink resolves through the real, un-stubbed
  // Sentry loader (server/sentry.ts), which is inert under VITEST — so it
  // is a transparent pass-through here, exactly as it is in every other
  // test in this file, and its own span-emitting behavior is unit-tested
  // in sentry-ai.test.ts against a fake sink it is handed directly.  What
  // IS observable at the driver level, with no Sentry stubbing at all, is
  // the generic event-driven path every consumer (including the real
  // server/index.ts bus) actually uses: turn.started/item.started/
  // item.completed/turn.completed feed observeRuntimeEvent, which is what
  // produces the invoke_agent and execute_tool spans this test asserts on.
  it("produces one invoke_agent span with one execute_tool child per tool call — never duplicated by also calling recordExecutedTools", async () => {
    const { sink, spans } = recordingSink();
    let round = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      round += 1;
      return round === 1
        ? sse(...TOOL_CALL_ROUND)
        : sse(
            '{"choices":[{"delta":{"content":"here you go"}}]}',
            '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}',
          );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax-spans",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "secret" },
    });
    // Mirrors how server/index.ts's real bus feeds EVERY driver's events
    // through observeRuntimeEvent generically — nothing MiniMax-specific
    // is wired here, which is the whole point.
    instance.adapter.onEvent((event) => observeRuntimeEvent(event, sink));
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread",
      text: "who is around?",
      tools: [{ name: "list_bots" }, { name: "ask_bot" }],
      toolHost: answeringHost,
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(spans.filter((s) => s.op === "gen_ai.invoke_agent")).toHaveLength(1);
    // one execute_tool span per tool call, from item.started/item.completed
    // alone — recordExecutedTools is deliberately NOT also called for this
    // driver, or this count would be 4, not 2
    expect(spans.filter((s) => s.op === "gen_ai.execute_tool")).toHaveLength(2);
    expect(spans.every((s) => s.ended)).toBe(true);
    recorder.stop();
    await instance.dispose();
  });

  it("caps an oversized transcript before folding it into the chat-completions payload", async () => {
    // The Codex review found that an unbounded transcript can grow past the
    // model's prompt window or the provider's per-request size.  This test
    // confirms the byte-cap is wired in: a 400 KiB transcript gets trimmed
    // down to ~200 KiB on the wire, so a long thread no longer re-uploads
    // its full history on every round.
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse(
        '{"choices":[{"delta":{"content":"ok"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "test-key" },
    });
    try {
      const big = "x".repeat(5_000);
      const transcript = Array.from({ length: 80 }, () => ({ role: "user" as const, text: big }));
      await instance.adapter.sendTurn({ threadId: "t-cap", transcript, text: "hi" });
      await new Promise((r) => setTimeout(r, 50));
      const body = bodies[0];
      // Capped transcript + system + final user; default cap is 200 KiB
      // which fits ~40 entries, not 80.
      const userMsgs = body.messages.filter((m: any) => m.role === "user");
      expect(userMsgs.length).toBeLessThan(80);
      const total = userMsgs.reduce(
        (s: number, m: any) => s + (typeof m.content === "string" ? m.content.length : 0),
        0,
      );
      expect(total).toBeLessThan(80 * 5_000);
    } finally {
      await instance.dispose();
    }
  });

  it("heads the request with the stable half and carries the volatile half on the newest user message", async () => {
    // Upstream PR #1758, HTTP half: the system message is the head of the
    // resent prefix, so only the stable half belongs there, and the volatile
    // half (memory, mentions) rides the newest user message every request.
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse(
        '{"choices":[{"delta":{"content":"ok"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      );
    }));
    const instance = await MinimaxDriver.create({
      instanceId: "minimax",
      displayName: "MiniMax",
      enabled: true,
      config: MinimaxDriver.defaultConfig(),
      environment: { MINIMAX_API_KEY: "test-key" },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-split",
        system: "You are a test bot. Memory: likes tea.",
        systemStable: "You are a test bot.",
        systemVolatile: " Memory: likes tea.",
        transcript: [{ role: "user", text: "earlier" }, { role: "assistant", text: "noted" }],
        text: "Summarize it.",
      });
      await recorder.until((event) => event.type === "turn.completed");
      expect(bodies[0].messages).toEqual([
        { role: "system", content: "You are a test bot." },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "noted" },
        { role: "user", content: `${VOLATILE_CONTEXT_NOTE_PREFIX}\n\nMemory: likes tea.\n\nSummarize it.` },
      ]);

      // a legacy unsplit turn keeps its whole prompt in the system message
      await instance.adapter.sendTurn({ threadId: "t-unsplit", system: "You are a test bot. Memory: likes tea.", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === "t-unsplit");
      expect(bodies[1].messages).toEqual([
        { role: "system", content: "You are a test bot. Memory: likes tea." },
        { role: "user", content: "hi" },
      ]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});
