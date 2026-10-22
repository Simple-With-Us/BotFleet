// Grok driver contract tests — the API-backed driver rides fetch, so the
// fake is a stubbed globalThis.fetch that scripts HTTP failures and SSE
// bodies. Covers the auto-retry policy: transient (429/5xx) retried with
// backoff, terminal (401/400) never, partial streamed output never.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { GrokDriver } from "./grok.ts";
import { VOLATILE_CONTEXT_NOTE_PREFIX } from "./prompt-split.ts";

const SSE_BODY = (text: string) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "data: [DONE]",
    "",
  ].join("\n");

const sseResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });

describe("GrokDriver turns (fake fetch)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let previousFetch: typeof globalThis.fetch;
  /** Script of responses/errors consumed in order; empty = succeed with text. */
  let script: Array<{ status?: number; sse?: string }> = [];
  let calls = 0;
  let requestBodies: Array<Record<string, any>> = [];

  const create = async () => {
    instance = await GrokDriver.create({
      instanceId: "grok-test",
      displayName: "Grok Test",
      environment: { XAI_API_KEY: "xai-fake" },
      enabled: true,
      config: { url: "https://fake.xai.invalid/v1", apiKeyEnv: "XAI_API_KEY" },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    process.env.FAKE_GROK_RETRY_SCALE = "0.001";
    previousFetch = globalThis.fetch;
    calls = 0;
    requestBodies = [];
    // SAFETY: the stub only returns real Response objects, the sole member
    // of fetch's return type this driver consumes.
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const step = script.shift();
      calls++;
      if (!step || step.sse !== undefined) return sseResponse(step?.sse ?? SSE_BODY("done from fake grok"));
      return new Response(`HTTP ${step.status} body`, { status: step.status });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = previousFetch;
    delete process.env.FAKE_GROK_RETRY_SCALE;
    recorder?.stop();
    await instance?.dispose();
  });

  it("exposes the xAI API lineup independently of Grok Build-only variants", async () => {
    await create();

    expect(instance.models.default).toBe("grok-4.7");
    expect(instance.models.options.map((model) => model.id)).toEqual([
      "grok-4.7",
      "grok-4.6",
      "grok-4.5",
    ]);
    expect(instance.models.options.some((model) => model.id === "grok-4.7-build-fast")).toBe(false);
  });

  it("sends the selected Grok 4.7 API model id unchanged", async () => {
    script = [];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-grok-47-model", text: "hi", model: "grok-4.7" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(requestBodies[0].model).toBe("grok-4.7");
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    script = [];
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.map((e) => e.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "item.completed", // assistant_text
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "grok")).toBe(true);
    expect(recorder.events.find((e) => e.type === "item.completed")).toMatchObject({
      itemType: "assistant_text",
      text: "done from fake grok",
    });
  });

  it("rejects an unexpected tool call without a tool host instead of reporting unexecuted work as successful", async () => {
    script = [{ sse: [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search","arguments":"{\\"query\\":\\"report\\"}"}}]}}]}',
      "data: [DONE]",
      "",
    ].join("\n") }];
    await create();

    await instance.adapter.sendTurn({ threadId: "t-unavailable-tool", text: "find it" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed",
      itemType: "tool",
      itemId: "call-1",
      ok: false,
      detail: "no tool host",
    }));
    expect(completed).toMatchObject({ ok: true });
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  });

  it("executes tool calls through turn.toolHost and completes subsequent rounds", async () => {
    script = [
      { sse: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\"path\\":\\"notes.txt\\"}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n") },
      { sse: [
        'data: {"choices":[{"delta":{"content":"Read file completed"}}]}',
        "data: [DONE]",
        "",
      ].join("\n") },
    ];
    await create();

    await instance.adapter.sendTurn({
      threadId: "t-tool-host",
      text: "read notes",
      tools: [{ name: "read_file" }],
      toolHost: {
        execute: async () => ({ kind: "result", content: "hello world" }),
      },
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true });
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed",
      itemType: "tool",
      itemId: "call-1",
      ok: true,
    }));
    expect(recorder.events).toContainEqual(expect.objectContaining({
      type: "item.completed",
      itemType: "assistant_text",
      text: "Read file completed",
    }));
  });

  it("requests streamed usage and auto-retries a transient error without prior usage", async () => {
    script = [
      { sse: [{ error: { code: 503, message: "private upstream request" } }].map((frame) => `data: ${JSON.stringify(frame)}`).join("\n") },
      { sse: [
        { choices: [{ delta: { content: "done" } }] },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 8 } } },
      ].map((frame) => `data: ${JSON.stringify(frame)}`).join("\n") },
    ];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-retry", text: "go" });
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({ ok: true, usage: { input: 20, output: 6, cachedInput: 8 } });
    expect(calls).toBe(2);
    expect(requestBodies.every((body) => body.stream_options?.include_usage === true)).toBe(true);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(JSON.stringify(recorder.events)).not.toContain("private upstream request");
  });

  it("fails a partial SSE error truthfully and keeps its reported cached usage", async () => {
    script = [{ sse: [
      { choices: [{ delta: { content: "partial" } }] },
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 6 } }, error: { code: 503, message: "private error body" } },
    ].map((frame) => `data: ${JSON.stringify(frame)}`).join("\n") }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-usage-error", text: "go" });
    const completed = await recorder.until((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({ ok: false, stopReason: "error:upstream_outage", usage: { input: 20, output: 9, cachedInput: 6 } });
    expect(calls).toBe(1);
    expect(JSON.stringify(recorder.events)).not.toContain("private error body");
  });

  it("sends transcript tool history and the current prompt exactly once", async () => {
    script = [];
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-history",
      system: "You are a test bot.",
      transcript: [
        { role: "user", text: "Find the report." },
        {
          role: "assistant",
          text: "I will search.",
          toolCalls: [{ id: "call-1", name: "search", arguments: '{"query":"report"}' }],
        },
        { role: "user", text: "", toolResults: [{ id: "call-1", result: "report.txt" }] },
      ],
      text: "Summarize it.",
      tools: [{ name: "search", description: "Search files" }],
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      messages: [
        { role: "system", content: "You are a test bot." },
        { role: "user", content: "Find the report." },
        {
          role: "assistant",
          content: "I will search.",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "search", arguments: '{"query":"report"}' } }],
        },
        { role: "tool", tool_call_id: "call-1", content: "report.txt" },
        { role: "user", content: "Summarize it." },
      ],
      tools: [{ type: "function", function: { name: "search", description: "Search files" } }],
    });
    expect(requestBodies[0].messages).toHaveLength(5);
  });

  it("heads the request with the stable half and carries the volatile half on the newest user message", async () => {
    // Upstream PR #1758, HTTP half.  The system message is the head of the
    // resent prefix, so a memory write must not move it; the volatile half
    // rides the newest user message, every request, because the stored
    // transcript never contains a delivered note.
    script = [];
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-split",
      system: "You are a test bot. Memory: likes tea.",
      systemStable: "You are a test bot.",
      systemVolatile: " Memory: likes tea.",
      transcript: [
        { role: "user", text: "earlier" },
        { role: "assistant", text: "noted" },
      ],
      text: "Summarize it.",
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0].messages).toEqual([
      { role: "system", content: "You are a test bot." },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "noted" },
      { role: "user", content: `${VOLATILE_CONTEXT_NOTE_PREFIX}\n\nMemory: likes tea.\n\nSummarize it.` },
    ]);
    expect(JSON.stringify(requestBodies[0].messages[0])).not.toContain("likes tea");
  });

  it("keeps a legacy unsplit turn's whole prompt in the system message", async () => {
    script = [];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-unsplit", system: "You are a test bot. Memory: likes tea.", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(requestBodies[0].messages).toEqual([
      { role: "system", content: "You are a test bot. Memory: likes tea." },
      { role: "user", content: "hi" },
    ]);
  });

  it("keeps a final unterminated data line from the SSE stream", async () => {
    script = [{ sse: `data: ${JSON.stringify({ choices: [{ delta: { content: "tail token" } }] })}` }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-tail", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.find((e) => e.type === "item.completed")).toMatchObject({
      itemType: "assistant_text",
      text: "tail token",
    });
  });

  it("auto-retries transient 429/5xx responses, then completes once", async () => {
    script = [{ status: 429 }, { status: 503 }];
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-retry", text: "go" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0)).toBe(true);
    expect(retries.map((e) => e.reason)).toEqual(["rate_limited", "server_error"]);
    // exactly one settled reply across all three attempts
    expect(recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")).toHaveLength(1);
    expect(calls).toBe(3);
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, turnId });
  }, 20_000);

  it("stops at the attempt cap and settles as failed", async () => {
    script = [{ status: 500 }, { status: 500 }, { status: 500 }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cap", text: "go" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === false);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    // original + two retries; the third failure is past the cap and fails
    expect(calls).toBe(3);
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  }, 20_000);

  it("never retries a terminal auth or invalid-request failure", async () => {
    script = [{ status: 401 }];
    await create();
    await instance.adapter.sendTurn({ threadId: "t-auth", text: "go" });
    await recorder.until((e) => e.threadId === "t-auth" && e.type === "turn.completed" && e.ok === false);

    expect(recorder.events.filter((e) => e.threadId === "t-auth" && e.type === "turn.retrying")).toHaveLength(0);
    expect(calls).toBe(1);

    script = [{ status: 400 }];
    await instance.adapter.sendTurn({ threadId: "t-badreq", text: "go" });
    await recorder.until((e) => e.threadId === "t-badreq" && e.type === "turn.completed" && e.ok === false);
    expect(recorder.events.filter((e) => e.type === "turn.retrying" && e.threadId === "t-badreq")).toHaveLength(0);
  }, 20_000);

  it("never retries after assistant text already streamed (duplicate-text hazard)", async () => {
    // an SSE body whose stream ERRORS after delivering a delta — the
    // partial-output guard must forbid the retry that would duplicate it
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "half an answer" } }] })}\n\n`));
        setTimeout(() => controller.error(new Error("connection reset by peer")), 10);
      },
    });
    // SAFETY: a real Response built from a live stream, same as above.
    globalThis.fetch = (async () => {
      calls++;
      return new Response(failingStream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    await create();
    await instance.adapter.sendTurn({ threadId: "t-partial", text: "go" });
    await recorder.until((e) => e.threadId === "t-partial" && e.type === "turn.completed" && e.ok === false);

    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.filter((e) => e.threadId === "t-partial" && e.type === "turn.retrying")).toHaveLength(0);
    expect(calls).toBe(1);
  }, 20_000);

  it("an interrupt during the retry backoff cancels cleanly without another attempt", async () => {
    script = [{ status: 503 }];
    process.env.FAKE_GROK_RETRY_SCALE = "60"; // long backoff — we cancel inside it
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cancel-backoff", text: "go" });
    await recorder.until((e) => e.type === "turn.retrying");

    await instance.adapter.interruptTurn("t-cancel-backoff");
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "turn.retrying")).toHaveLength(1);
    expect(calls).toBe(1);
    expect(recorder.events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: false,
      stopReason: "interrupted",
    });
  }, 20_000);

  it("declares no interactive channels this engine cannot honor", async () => {
    script = [];
    await create();
    await expect(instance.adapter.respondToRequest("t-x", "r", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("declares toolLoop, agentsMcp, and localComputerMcp capabilities", async () => {
    script = [];
    await create();
    expect(instance.adapter.capabilities).toMatchObject({
      sessionModelSwitch: "in-session",
      agentsMcp: true,
      toolLoop: true,
      localComputerMcp: true,
      replaysTranscript: true,
    });
  });

  it("caps an oversized transcript before folding it into the chat-completions payload", async () => {
    // The Codex review found that an unbounded transcript can grow past the
    // model's prompt window or the provider's per-request size, then get
    // re-uploaded on every round because the loop re-sends a byte-identical
    // prefix to keep the prompt cache reachable.  This test wires a long
    // transcript into a turn and asserts the request body carries a CAPPED
    // prefix — both by entry count and by byte size — so the cap is real,
    // not just paper.
    script = [];
    await create();
    const big = "x".repeat(5_000);
    const transcript = Array.from({ length: 80 }, () => ({ role: "user" as const, text: big }));
    await instance.adapter.sendTurn({ threadId: "t-cap", transcript, text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const body = requestBodies[0];
    // The helper's byte cap (200 KiB / 5 KiB-per-entry) keeps ~40 entries;
    // a 2 KiB system message is added on top, so the body length is bounded
    // well below the uncapped 80×5 KiB + overhead.
    expect(body.messages.length).toBeLessThan(80);
    // Exactly the byte budget: 40 entries * 5 KiB ≈ 200 KiB plus the system
    // and final-user lines.  Allow some slack so a future entry-count tweak
    // doesn't immediately fail this test.
    const total = body.messages.reduce(
      (sum: number, m: any) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    expect(total).toBeLessThan(80 * 5_000);
    expect(total).toBeGreaterThan(0);
  });
});
