import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sentryAi from "../sentry-ai.ts";
import { recordEvents } from "../testing/events.ts";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "../testing/fake-openai-server.ts";
import { OpenAICompatDriver, sentryProviderForUrl } from "./openai-compat.ts";
import { VOLATILE_CONTEXT_NOTE_PREFIX } from "./prompt-split.ts";

describe("OpenAICompatDriver", () => {
  const savedUrl = process.env.OPENAI_COMPAT_URL;
  const savedKey = process.env.OPENAI_COMPAT_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_COMPAT_URL;
    delete process.env.OPENAI_COMPAT_API_KEY;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.OPENAI_COMPAT_URL;
    else process.env.OPENAI_COMPAT_URL = savedUrl;
    if (savedKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
    else process.env.OPENAI_COMPAT_API_KEY = savedKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the openai-compat kind and a display name", () => {
    expect(OpenAICompatDriver.driverKind).toBe("openai-compat");
    expect(OpenAICompatDriver.metadata.displayName).toMatch(/OpenRouter|Groq/);
  });

  it("marks its install descriptor apiKeyOnly — no CLI, so the setup UI never says install or sign in", () => {
    expect(OpenAICompatDriver.install?.apiKeyOnly).toBe(true);
  });

  it("falls back to the OpenRouter endpoint by default", () => {
    const cfg = OpenAICompatDriver.defaultConfig();
    expect(cfg.url).toBe("https://openrouter.ai/api/v1");
    expect(cfg.apiKeyEnv).toBe("OPENAI_COMPAT_API_KEY");
  });

  it("honours an explicit url and apiKeyEnv override", () => {
    const cfg = OpenAICompatDriver.decodeConfig({
      url: "https://api.groq.com/openai/v1/",
      apiKeyEnv: "GROQ_KEY",
    });
    expect(cfg.url).toBe("https://api.groq.com/openai/v1");
    expect(cfg.apiKeyEnv).toBe("GROQ_KEY");
  });

  it("reports unavailable without an API key for the workspace-shared instance", async () => {
    // "openaiCompat" is the one reserved instance id backed by the shared
    // openaiCompat.key/OPENAI_COMPAT_API_KEY credential — it still requires
    // a key. A user-added custom instance does not; see the "keyless custom
    // engine" tests below.
    const inst = await OpenAICompatDriver.create({
      instanceId: "openaiCompat",
      displayName: "Free",
      enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("unavailable");
    await inst.dispose();
  });

  it("permits a keyless custom instance (e.g. local Ollama/LM Studio) to be available", async () => {
    const inst = await OpenAICompatDriver.create({
      instanceId: "custom-ollama-local",
      displayName: "Ollama Local",
      enabled: true,
      config: { url: "http://localhost:11434/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.authenticated).toBe(true);
    await inst.dispose();
  });

  it("omits the Authorization header for a keyless custom instance", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      expect(init?.headers).not.toHaveProperty("authorization");
      return new Response("data: [DONE]\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const inst = await OpenAICompatDriver.create({
      instanceId: "custom-ollama-local",
      displayName: "Ollama Local",
      enabled: true,
      config: { url: "http://localhost:11434/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const recorder = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "thread", text: "hi", model: "llama3" });
    await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    await inst.dispose();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("never sends the workspace-shared process.env credential to a custom instance", async () => {
    // syncCredentialEnv copies a saved openaiCompat.key into
    // process.env.OPENAI_COMPAT_API_KEY as soon as it's saved — that env var
    // is process-wide, not scoped to the reserved "openaiCompat" instance,
    // so every openai-compat instance's own process.env lookup would
    // otherwise see it. A user-added custom instance must never forward that
    // workspace credential to whatever arbitrary endpoint the user typed in.
    process.env.OPENAI_COMPAT_API_KEY = "sk-workspace-secret";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      expect(init?.headers).not.toHaveProperty("authorization");
      return new Response("data: [DONE]\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const inst = await OpenAICompatDriver.create({
      instanceId: "custom-untrusted-endpoint",
      displayName: "Untrusted Endpoint",
      enabled: true,
      config: { url: "https://untrusted.example.test/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const recorder = recordEvents(inst.adapter);
    await inst.adapter.sendTurn({ threadId: "thread", text: "hi", model: "llama3" });
    await recorder.until((event) => event.type === "turn.completed");
    recorder.stop();
    await inst.dispose();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("still lets the reserved workspace instance fall back to process.env", async () => {
    process.env.OPENAI_COMPAT_API_KEY = "sk-workspace-secret";
    const inst = await OpenAICompatDriver.create({
      instanceId: "openaiCompat",
      displayName: "Free",
      enabled: true,
      config: { url: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
      environment: {},
    });
    const snap = await inst.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.authenticated).toBe(true);
    await inst.dispose();
  });

  it("exposes a refreshed model catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "vendor/model-a", name: "Model A" },
              { id: "vendor/model-b" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-models",
      displayName: "Models",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await inst.refreshModels?.();

    expect(inst.models).toEqual({
      default: "vendor/model-a",
      options: [
        { id: "vendor/model-a", label: "Model A" },
        { id: "vendor/model-b", label: "vendor/model-b" },
      ],
    });
    await inst.dispose();
  });

  it("includes streamed token totals in turn.completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-turn",
      displayName: "Turn",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread", text: "private prompt", model: "vendor/model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 12, output: 3 } });
    recorder.stop();
    await inst.dispose();
  });

  it("streams reasoning separately and completes only actual assistant text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n' +
            'data: {"choices":[{"delta":{"content":"answer"}}]}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-stream",
      displayName: "Reasoning",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "reasoning-thread", text: "question", model: "vendor/model" });
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
    await inst.dispose();
  });

  it("uses reasoning as a helper-model fallback when normal content is whitespace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content: "  ", reasoning_content: "usable result" } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-helper",
      displayName: "Reasoning helper",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });

    await expect(inst.generateText?.("question")).resolves.toBe("usable result");
    await inst.dispose();
  });

  it("falls back to reasoning_content when content is empty (streaming)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"reasoning_content":"thinking through the problem"}}]}\n' +
            'data: {"choices":[{"delta":{"content":""}}]}\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-reasoning-fallback-stream",
      displayName: "Reasoning Fallback",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({ threadId: "thread-rf", text: "prompt", model: "vendor/model" });
    const item = await recorder.until((e) => e.type === "item.completed");
    const completed = await recorder.until((e) => e.type === "turn.completed");

    expect(item).toMatchObject({
      type: "item.completed",
      itemType: "assistant_text",
      text: "thinking through the problem",
    });
    expect(completed).toMatchObject({ ok: true, usage: { input: 10, output: 5 } });

    const deltas = recorder.events.filter((e) => e.type === "content.delta");
    expect(deltas.some((d: any) => d.streamKind === "reasoning_text" && d.delta === "thinking through the problem")).toBe(true);

    recorder.stop();
    await inst.dispose();
  });
});

describe("OpenAICompatDriver tool steps", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("settles a contract-shaped tool step with the host's real outcome", async () => {
    // it used to emit `tool_call.delta` and `itemType: "tool_call"`, neither
    // of which is in the RuntimeEvent union — both were cast past the type
    // checker, the harness had no arm for either, and a turn that called a
    // tool rendered no steps at all
    let round = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        round += 1;
        return round === 1 ? new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":""}}]}}]}\n' +
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file_path\\":\\"/srv/app/store.ts\\"}"}}]}}]}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ) : new Response(
          'data: {"choices":[{"delta":{"content":"done"}}]}\ndata: [DONE]\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-tool-steps",
      displayName: "Tools",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "tool-thread",
      text: "read it",
      model: "vendor/model",
      tools: [{ name: "read_file" }],
      toolHost: { execute: async () => ({ kind: "result", content: "file contents" }) },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const started = recorder.events.filter(
      (event) => event.type === "item.started" && event.itemType === "tool",
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ itemId: "call_1", title: "read_file", toolKind: "read" });

    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "tool", itemId: "call_1", ok: true }),
    );
    // the old off-contract shapes cannot recur: `tool_call.delta` and
    // `itemType: "tool_call"` are not in the RuntimeEvent union, so the type
    // checker now refuses them where an `as any` used to wave them through
    recorder.stop();
    await inst.dispose();
  });

  it("does not open a second step for a call whose arguments streamed in fragments", async () => {
    let round = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        round += 1;
        return round === 1 ? new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"bash","arguments":"{\\"comm"}}]}}]}\n' +
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"arguments":"and\\":\\"ls\\"}"}}]}}]}\n' +
            "data: [DONE]\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ) : new Response(
          'data: {"choices":[{"delta":{"content":"done"}}]}\ndata: [DONE]\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-tool-fragments",
      displayName: "Tools",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(inst.adapter);

    await inst.adapter.sendTurn({
      threadId: "fragment-thread",
      text: "run it",
      model: "vendor/model",
      tools: [{ name: "bash" }],
      toolHost: { execute: async () => ({ kind: "result", content: "ok" }) },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const started = recorder.events.filter(
      (event) => event.type === "item.started" && event.itemType === "tool",
    );
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ itemId: "call_a", toolKind: "execute" });
    recorder.stop();
    await inst.dispose();
  });

  it("advertises local-computer capability for host computer execution via toolHost", async () => {
    const inst = await OpenAICompatDriver.create({
      instanceId: "test-caps",
      displayName: "Caps",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
      environment: { TEST_KEY: "secret" },
    });
    expect(inst.adapter.capabilities.localComputerMcp).toBe(true);
    expect(await inst.adapter.respondToRequest("t", "r", { behavior: "allow" })).toBe("unavailable");
    await inst.dispose();
  });
});

describe("OpenAICompatDriver driver-owned tool loop", () => {
  let server: FakeOpenAiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps one turn across tool rounds with cumulative usage and an unchanged prefix", async () => {
    const legacyToolSpans = vi.spyOn(sentryAi, "recordExecutedTools");
    server = await startFakeOpenAiServer();
    server.queueCompletion({
      kind: "sse",
      frames: [
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_bots","arguments":"{}"}}]}}]}',
        '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}',
        "[DONE]",
      ],
    });
    server.queueCompletion({
      kind: "sse",
      frames: [
        '{"choices":[{"delta":{"content":"two bots"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":8}}}',
        "[DONE]",
      ],
    });
    const instance = await OpenAICompatDriver.create({
      instanceId: "openai-loop-test",
      displayName: "Loop",
      enabled: true,
      config: { url: server.url, apiKeyEnv: "TEST_KEY", models: ["fake-model"] },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);
    const requestApproval = vi.fn(async () => "allowed-once" as const);

    await instance.adapter.sendTurn({
      threadId: "loop-thread",
      text: "list my bots",
      model: "fake-model",
      tools: [{ name: "list_bots" }],
      toolHost: {
        requestApproval,
        execute: async (_call, runtime) => {
          const outcome = await runtime.requestApproval({ tool: "list_bots", summary: "Read bot names" });
          return { kind: "result", content: outcome === "allowed-once" ? "[]" : "denied" };
        },
      },
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(completed).toMatchObject({
      ok: true,
      stopReason: "end_turn",
      usage: { input: 30, output: 12, cachedInput: 12 },
    });
    const requests = server.requests.filter((request) => request.url.endsWith("/chat/completions"));
    expect(requests).toHaveLength(2);
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(legacyToolSpans).not.toHaveBeenCalled();
    expect(recorder.events.filter((event) => event.type === "item.started" && event.itemType === "tool")).toHaveLength(1);
    expect(recorder.events.filter((event) => event.type === "item.completed" && event.itemType === "tool")).toHaveLength(1);
    for (const request of requests) expect(request.body).toMatchObject({ stream_options: { include_usage: true } });
    const first = (requests[0].body as { messages: unknown[] }).messages;
    const second = (requests[1].body as { messages: unknown[] }).messages;
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.slice(first.length)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "list_bots", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "[]" },
    ]);
    recorder.stop();
    await instance.dispose();
  });

  it("retains streamed usage when the provider fails before the round settles", async () => {
    const recordUsage = vi.fn();
    vi.spyOn(sentryAi, "withChatSpan").mockImplementation(async (_opts, fn) => fn({
      recordUsage,
      span: { setAttribute() {}, end() {} },
    }));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9}}\n',
          ));
          return;
        }
        controller.error(new Error("stream exploded"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const instance = await OpenAICompatDriver.create({
      instanceId: "openai-usage-failure",
      displayName: "Usage failure",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY", models: ["fake-model"] },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "usage-failure", text: "hi", model: "fake-model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "error", usage: { input: 20, output: 9 } });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ input: 20, output: 9 }));
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    recorder.stop();
    await instance.dispose();
  });

  it.each([
    [400, "stream_options: extra inputs are not permitted"],
    [422, "This endpoint does not support stream_options"],
  ])("retries an explicit unsupported stream_options rejection (%s: %s) once", async (status, error) => {
    server = await startFakeOpenAiServer();
    server.queueCompletion({ kind: "json", status, body: { error } });
    server.queueCompletion({ kind: "sse", frames: ['{"choices":[{"delta":{"content":"compatible"}}]}', "[DONE]"] });
    const instance = await OpenAICompatDriver.create({
      instanceId: "optional-usage", displayName: "Optional usage", enabled: true,
      config: { url: server.url, apiKeyEnv: "UNSET_OPTIONAL_KEY", models: ["fake-model"] }, environment: {},
    });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "optional-usage", text: "hi", model: "fake-model" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    const requests = server.requests.filter((request) => request.url.endsWith("/chat/completions"));
    expect(requests).toHaveLength(2);
    expect(requests[0].body).toHaveProperty("stream_options", { include_usage: true });
    expect(requests[1].body).not.toHaveProperty("stream_options");
    expect(requests[1].body).toMatchObject({ model: "fake-model", stream: true });
    recorder.stop();
    await instance.dispose();
  });

  it.each([
    [400, "private prompt invalid messages"],
    [401, "private prompt stream_options unsupported"],
    [422, "private prompt stream_options must be an object"],
  ])("does not retry unrelated HTTP %s errors or expose their body", async (status, error) => {
    server = await startFakeOpenAiServer();
    server.queueCompletion({ kind: "json", status: Number(status), body: { error } });
    const instance = await OpenAICompatDriver.create({
      instanceId: "invalid-request", displayName: "Invalid request", enabled: true,
      config: { url: server.url, apiKeyEnv: "UNSET_OPTIONAL_KEY", models: ["fake-model"] }, environment: {},
    });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "invalid-request", text: "hi", model: "fake-model" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
    expect(server.requests.filter((request) => request.url.endsWith("/chat/completions"))).toHaveLength(1);
    expect(JSON.stringify(recorder.events)).not.toContain("private prompt");
    recorder.stop();
    await instance.dispose();
  });

  it("bounds the compatibility retry and preserves the original abort signal", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response('{"error":"stream_options unsupported"}', { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await OpenAICompatDriver.create({
      instanceId: "bounded-retry", displayName: "Bounded retry", enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "UNSET_OPTIONAL_KEY", models: ["fake-model"] }, environment: {},
    });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "bounded-retry", text: "hi", model: "fake-model" });
    expect(await recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
    recorder.stop();
    await instance.dispose();
  });

  it("fails on an upstream SSE error while retaining reported cached usage", async () => {
    server = await startFakeOpenAiServer();
    server.queueCompletion({ kind: "sse", frames: [
      '{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":6}}}',
      '{"error":{"code":502,"message":"private request detail"}}',
      "[DONE]",
    ] });
    const instance = await OpenAICompatDriver.create({
      instanceId: "openai-stream-error", displayName: "Stream error", enabled: true,
      config: { url: server.url, apiKeyEnv: "TEST_KEY", models: ["fake-model"] },
      environment: { TEST_KEY: "secret" },
    });
    const recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ threadId: "stream-error", text: "hi", model: "fake-model" });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: false, usage: { input: 20, output: 9, cachedInput: 6 } });
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(JSON.stringify(recorder.events)).not.toContain("private request detail");
    recorder.stop();
    await instance.dispose();
  });

  it("rejects an invalid dispatch before starting a turn", async () => {
    const instance = await OpenAICompatDriver.create({
      instanceId: "openaiCompat",
      displayName: "Missing key",
      enabled: true,
      config: { url: "https://example.test/v1", apiKeyEnv: "MISSING_TEST_KEY", models: ["fake-model"] },
      environment: {},
    });
    const recorder = recordEvents(instance.adapter);

    await expect(instance.adapter.sendTurn({ threadId: "rejected", text: "hi" })).rejects.toThrow(/no API key/);
    expect(recorder.events).toEqual([]);
    expect(instance.adapter.hasSession("rejected")).toBe(false);
    recorder.stop();
    await instance.dispose();
  });

  it("caps an oversized transcript before folding it into the chat-completions payload", async () => {
    // Same intent as the matching tests on grok.ts and minimax.ts: the
    // Codex review's replay-without-byte-limit finding applies equally to
    // any chat-completions driver that re-uploads the prefix every round.
    const bodies: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "openai-compat-cap",
      displayName: "Cap Test",
      enabled: true,
      config: { url: "https://example.com/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY", key: "test-key" },
      environment: {},
    });
    try {
      const big = "x".repeat(5_000);
      const transcript = Array.from({ length: 80 }, () => ({ role: "user" as const, text: big }));
      await instance.adapter.sendTurn({ threadId: "t-cap", transcript, text: "hi" });
      // The /models probe + the completion = 2 calls.  Body[0] is /models,
      // body[1] is the chat-completions request.
      await new Promise((r) => setTimeout(r, 50));
      const body = bodies.find((b: any) => Array.isArray(b.messages));
      expect(body).toBeDefined();
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
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));
    const instance = await OpenAICompatDriver.create({
      instanceId: "openai-compat-split",
      displayName: "Split Test",
      enabled: true,
      config: { url: "https://example.com/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY", key: "test-key" },
      environment: {},
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
      const body = bodies.find((b: any) => Array.isArray(b.messages));
      expect(body.messages).toEqual([
        { role: "system", content: "You are a test bot." },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "noted" },
        { role: "user", content: `${VOLATILE_CONTEXT_NOTE_PREFIX}\n\nMemory: likes tea.\n\nSummarize it.` },
      ]);

      // a legacy unsplit turn keeps its whole prompt in the system message
      await instance.adapter.sendTurn({ threadId: "t-unsplit", system: "You are a test bot. Memory: likes tea.", text: "hi" });
      await recorder.until((event) => event.type === "turn.completed" && event.threadId === "t-unsplit");
      const legacy = bodies.filter((b: any) => Array.isArray(b.messages)).at(-1);
      expect(legacy.messages).toEqual([
        { role: "system", content: "You are a test bot. Memory: likes tea." },
        { role: "user", content: "hi" },
      ]);
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});

describe("Sentry provider for an OpenAI-compatible endpoint", () => {
  it("names the vendor actually answering, not the wire shape", () => {
    expect(sentryProviderForUrl("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(sentryProviderForUrl("https://api.groq.com/openai/v1")).toBe("groq");
    expect(sentryProviderForUrl("https://api.openai.com/v1")).toBe("openai");
  });

  it("falls back to openai-compat for anything else, matching on host only", () => {
    expect(sentryProviderForUrl("http://127.0.0.1:8080/v1")).toBe("openai-compat");
    expect(sentryProviderForUrl("https://together.xyz/v1")).toBe("openai-compat");
    // A look-alike host must not be read as the real one.
    expect(sentryProviderForUrl("https://openrouter.ai.example.com/v1")).toBe("openai-compat");
    expect(sentryProviderForUrl("https://notgroq.com/v1")).toBe("openai-compat");
    expect(sentryProviderForUrl("not a url")).toBe("openai-compat");
  });
});
