// Smoke test for fake-openai-server.ts: prove the fixture itself speaks the
// wire shape correctly before any driver test leans on it — SSE framing
// (including a trailing frame with no terminating newline), a JSON-mode
// reply, GET /v1/models, exact request-body recording across a scripted
// two-round tool exchange, header redaction, and the loud-failure path for
// an unscripted request.
import { afterEach, describe, expect, it } from "vitest";

import { startFakeOpenAiServer, type FakeOpenAiServer } from "./fake-openai-server.ts";

describe("fake-openai-server", () => {
  let server: FakeOpenAiServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("streams scripted SSE frames in order, including a trailing frame with no terminating newline", async () => {
    server = await startFakeOpenAiServer();
    server.queueCompletion({
      kind: "sse",
      frames: [
        '{"choices":[{"delta":{"content":"hi"}}]}',
        '{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
      ],
      omitTrailingNewline: true,
    });

    const res = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toBe(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
    );
    // no [DONE] scripted — this fixture never injects one on the caller's
    // behalf, so a driver's own [DONE]-independent flush is what gets tested
    expect(body).not.toContain("[DONE]");
  });

  it("answers a JSON-mode (non-stream) scripted reply", async () => {
    server = await startFakeOpenAiServer();
    server.queueCompletion({
      kind: "json",
      body: { choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    });

    const res = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", messages: [], stream: false }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0].message.content).toBe("hello");
  });

  it("answers GET /v1/models with a default catalog, or a queued one", async () => {
    server = await startFakeOpenAiServer();
    const defaultRes = await fetch(`${server.url}/models`);
    expect(await defaultRes.json()).toEqual({ data: [{ id: "fake-model", object: "model" }] });

    server.queueModels({ data: [{ id: "custom-model" }] });
    const customRes = await fetch(`${server.url}/models`);
    expect(await customRes.json()).toEqual({ data: [{ id: "custom-model" }] });
  });

  it("records the exact request body for each round of a scripted two-round tool exchange", async () => {
    server = await startFakeOpenAiServer();
    server.queueCompletion({
      kind: "sse",
      frames: [
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_bots","arguments":"{}"}}]}}]}',
        "[DONE]",
      ],
    });
    server.queueCompletion({
      kind: "sse",
      frames: ['{"choices":[{"delta":{"content":"here are your bots"}}]}', "[DONE]"],
    });

    const round1Body = { model: "fake-model", messages: [{ role: "user", content: "list my bots" }], stream: true };
    await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify(round1Body),
    }).then((r) => r.text());

    const round2Body = {
      model: "fake-model",
      messages: [
        { role: "user", content: "list my bots" },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "list_bots", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: '{"bots":[]}' },
      ],
      stream: true,
    };
    await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify(round2Body),
    }).then((r) => r.text());

    const completionRequests = server.requests.filter((r) => r.url.startsWith("/v1/chat/completions"));
    expect(completionRequests).toHaveLength(2);
    expect(completionRequests[0].body).toEqual(round1Body);
    expect(completionRequests[1].body).toEqual(round2Body);
    // the prefix from round 1 must survive byte-identical into round 2 —
    // this is the assertion PR 2's loop tests build on
    expect((completionRequests[1].body as typeof round2Body).messages[0]).toEqual(round1Body.messages[0]);
  });

  it("redacts the Authorization header value while still recording that one was sent", async () => {
    server = await startFakeOpenAiServer();
    server.queueCompletion({ kind: "json", body: { choices: [{ message: { content: "ok" } }] } });

    await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer super-secret-key", "content-type": "application/json" },
      body: "{}",
    });

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].headers.authorization).toBe("[present]");
    expect(JSON.stringify(server.requests)).not.toContain("super-secret-key");
  });

  it("fails loudly rather than hanging when a request arrives with nothing scripted", async () => {
    server = await startFakeOpenAiServer();
    const res = await fetch(`${server.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/no scripted response queued/);
  });

  it("answers 404 for an unrecognized route", async () => {
    server = await startFakeOpenAiServer();
    const res = await fetch(`${server.url}/not-a-real-route`);
    expect(res.status).toBe(404);
  });
});
