// Auto-review on the HTTP lanes.
//
// The `reviewPermission` contract (server/contracts.ts) asks for an isolated,
// tool-free call on the same provider with the prompt kept out of argv.  The
// HTTP lanes are the easiest engines to hold to that: one chat-completions
// request with no `tools`, the prompt in the request body, cancelled by the
// reviewer's own deadline.  These pin exactly that for each of the three, and
// that each one says its asks reach the card before they run.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { GrokDriver } from "./grok.ts";
import { MinimaxDriver } from "./minimax.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

interface Seen {
  url: string;
  /** The parsed request body, asserted on by shape. */
  body: unknown;
}

/** A fetch stub that answers a chat completion with `content` (and a
 *  reasoning field that must NOT become the verdict), records each request,
 *  and honours the request's abort signal. */
function stubFetch(content: string, options: { hang?: boolean } = {}): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      seen.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      if (options.hang) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(new DOMException("aborted", "AbortError"));
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content, reasoning_content: '{"allow":true,"reason":"from reasoning"}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return seen;
}

const ENGINES: Array<{ name: string; create: () => Promise<ProviderInstance> }> = [
  {
    name: "OpenAI-compatible",
    create: () =>
      OpenAICompatDriver.create({
        instanceId: "review-openai-compat",
        displayName: "Compat",
        enabled: true,
        config: { url: "https://example.test/v1", apiKeyEnv: "TEST_KEY" },
        environment: { TEST_KEY: "secret" },
      }),
  },
  {
    name: "MiniMax",
    create: () =>
      MinimaxDriver.create({
        instanceId: "review-minimax",
        displayName: "MiniMax",
        enabled: true,
        config: MinimaxDriver.defaultConfig(),
        environment: { MINIMAX_API_KEY: "secret" },
      }),
  },
  {
    name: "Grok (xAI API)",
    create: () =>
      GrokDriver.create({
        instanceId: "review-grok",
        displayName: "Grok",
        enabled: true,
        config: { url: "https://fake.xai.invalid/v1", apiKeyEnv: "XAI_API_KEY" },
        environment: { XAI_API_KEY: "xai-fake" },
      }),
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(ENGINES)("$name reviews its own approvals", ({ create }) => {
  it("declares that its asks reach the card before they run", async () => {
    stubFetch("");
    const instance = await create();
    expect(instance.adapter.capabilities.reviewHook).toBe("before");
    expect(instance.reviewPermission).toEqual(expect.any(Function));
    await instance.dispose();
  });

  it("sends one tool-free request with the prompt in the body and returns the answer text", async () => {
    const seen = stubFetch('{"allow":false,"reason":"deletes data"}');
    const instance = await create();
    const prompt = "review this: rm -rf build";
    await expect(instance.reviewPermission!(prompt, new AbortController().signal)).resolves.toBe(
      '{"allow":false,"reason":"deletes data"}',
    );
    const reviews = seen.filter((request) => request.url.endsWith("/chat/completions"));
    expect(reviews).toHaveLength(1);
    const body = reviews[0]!.body;
    expect(body).not.toHaveProperty("tools");
    expect(body).toMatchObject({ stream: false, messages: [{ role: "user", content: prompt }] });
    expect(body).toHaveProperty("messages", [{ role: "user", content: prompt }]);
    await instance.dispose();
  });

  it("never turns the model's reasoning into a verdict", async () => {
    stubFetch("");
    const instance = await create();
    await expect(instance.reviewPermission!("review", new AbortController().signal)).resolves.toBe("");
    await instance.dispose();
  });

  it("is cancelled by the reviewer's own deadline", async () => {
    stubFetch("", { hang: true });
    const instance = await create();
    const controller = new AbortController();
    const pending = instance.reviewPermission!("review", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await instance.dispose();
  });
});
