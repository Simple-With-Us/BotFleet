import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver, watchLocalModelServer } from "./openai-compat.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("stops a local reply after three consecutive failed model probes", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockRejectedValue(new TypeError("fixture server stopped"));
  vi.stubGlobal("fetch", fetchMock);
  const stop = new AbortController();
  const cleanup = watchLocalModelServer("http://127.0.0.1:11434/v1", "synthetic-key", stop, 100);
  try {
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stop.signal.aborted).toBe(true);
    expect(stop.signal.reason).toMatchObject({ message: expect.stringContaining("stopped answering") });
  } finally {
    cleanup();
  }
});

it("does not poll a cloud endpoint", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const stop = new AbortController();
  const cleanup = watchLocalModelServer("https://api.example.test/v1", "synthetic-key", stop, 100);
  try {
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stop.signal.aborted).toBe(false);
  } finally {
    cleanup();
  }
});

it("ignores probe timeouts and aborts an outstanding probe when the watcher is cleaned up", async () => {
  vi.useFakeTimers();
  const probeSignals: AbortSignal[] = [];
  const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal) probeSignals.push(signal);
    const abort = () => reject(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }));
  vi.stubGlobal("fetch", fetchMock);
  const stop = new AbortController();
  const cleanup = watchLocalModelServer("http://127.0.0.1:11434/v1", "", stop, 100);
  await vi.advanceTimersByTimeAsync(340);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(stop.signal.aborted).toBe(false);
  expect(probeSignals.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
  cleanup();
  expect(probeSignals[2]?.aborted).toBe(true);
});

it("keeps a slow first token alive while local /models probes keep answering", async () => {
  vi.useFakeTimers();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetchMock = vi.fn((input: string | URL | Request) => {
    if (String(input).endsWith("/models")) return Promise.resolve(new Response(null, { status: 503 }));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
    return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const instance = await OpenAICompatDriver.create({
    instanceId: "custom-ollama-slow-first-token",
    displayName: "Slow loopback fixture",
    enabled: true,
    config: { url: "http://127.0.0.1:11434/v1", apiKeyEnv: "FIXTURE_KEY", models: ["fixture"] },
    environment: { FIXTURE_KEY: "synthetic-key" },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "slow-first-token", text: "fixture", model: "fixture" });
    const completed = recorder.until((event) => event.type === "turn.completed", 200_000);
    for (let attempt = 0; attempt < 20 && !streamController; attempt++) await Promise.resolve();
    expect(streamController).toBeDefined();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/models"))).toHaveLength(3);
    expect(recorder.events.some((event) => event.type === "turn.completed")).toBe(false);
    // The server answered probes, so the stall watchdog is told the silent turn is alive.
    expect(instance.adapter.liveTurnThreadIds?.()).toEqual(["slow-first-token"]);
    // A 3-minute-default turn is not force-swept early either.
    expect(await instance.adapter.sweepStuckTurns?.(1)).toEqual([]);
    const encoder = new TextEncoder();
    streamController!.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first token"}}]}\n'));
    streamController!.enqueue(encoder.encode("data: [DONE]\n"));
    streamController!.close();
    expect(await completed).toMatchObject({ ok: true });
  } finally {
    recorder.stop();
    await instance.dispose();
  }
});

it("keeps caller cancellation effective for a pending local reply", async () => {
  const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const instance = await OpenAICompatDriver.create({
    instanceId: "custom-ollama",
    displayName: "Loopback fixture",
    enabled: true,
    config: { url: "http://127.0.0.1:11434/v1", apiKeyEnv: "FIXTURE_KEY", models: ["fixture"] },
    environment: { FIXTURE_KEY: "synthetic-key" },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "cancel-local", text: "fixture", model: "fixture" });
    const completed = recorder.until((event) => event.type === "turn.completed", 2_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await instance.adapter.interruptTurn("cancel-local");
    expect(await completed).toMatchObject({ ok: false });
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  } finally {
    recorder.stop();
    await instance.dispose();
  }
});

it("propagates caller cancellation through the long-wait Undici transport", async () => {
  let chatRequestSeen!: () => void;
  let chatRequestAborted!: () => void;
  const chatSeen = new Promise<void>((resolve) => { chatRequestSeen = resolve; });
  const chatAborted = new Promise<void>((resolve) => { chatRequestAborted = resolve; });
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
      return;
    }
    request.on("aborted", chatRequestAborted);
    chatRequestSeen();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: listen(0, "127.0.0.1") returns AddressInfo, never a pipe name.
  const address = server.address() as AddressInfo;
  const instance = await OpenAICompatDriver.create({
    instanceId: "custom-ollama-undici-cancel",
    displayName: "Undici cancellation fixture",
    enabled: true,
    config: { url: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "FIXTURE_KEY", models: ["fixture"], replyWaitMinutes: 5 },
    environment: { FIXTURE_KEY: "synthetic-key" },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "cancel-undici-local", text: "fixture", model: "fixture" });
    const completed = recorder.until((event) => event.type === "turn.completed", 2_000);
    await chatSeen;
    await instance.adapter.interruptTurn("cancel-undici-local");
    expect(await completed).toMatchObject({ ok: false });
    await expect(chatAborted).resolves.toBeUndefined();
  } finally {
    recorder.stop();
    await instance.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

it("ends a local turn on dead-server probes before the 3-minute default expires", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/models")) return Promise.reject(new TypeError("fixture server stopped"));
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const instance = await OpenAICompatDriver.create({
    instanceId: "custom-ollama-dead",
    displayName: "Dead loopback fixture",
    enabled: true,
    config: { url: "http://127.0.0.1:11434/v1", apiKeyEnv: "FIXTURE_KEY", models: ["fixture"] },
    environment: { FIXTURE_KEY: "synthetic-key" },
  });
  const recorder = recordEvents(instance.adapter);
  try {
    await instance.adapter.sendTurn({ threadId: "dead-local", text: "fixture", model: "fixture" });
    const completed = recorder.until((event) => event.type === "turn.completed", 200_000);
    for (let attempt = 0; attempt < 10 && !fetchMock.mock.calls.some(([input]) => String(input).endsWith("/chat/completions")); attempt++) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await completed).toMatchObject({ ok: false });
    expect(recorder.events.find((event) => event.type === "runtime.error")).toMatchObject({
      message: expect.stringContaining("stopped answering"),
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/models"))).toHaveLength(3);
  } finally {
    recorder.stop();
    await instance.dispose();
  }
});

it("skips the liveness probe while response bytes are arriving and reports the server alive", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const alive = vi.fn();
  let byteAgeMs = 1_000;
  const cleanup = watchLocalModelServer("http://127.0.0.1:11434/v1", "synthetic-key", new AbortController(), 30_000, () => Date.now() - byteAgeMs, alive);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(alive).toHaveBeenCalledTimes(1);
  byteAgeMs = 31_000;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(alive.mock.calls.length).toBeGreaterThanOrEqual(2);
  cleanup();
});
