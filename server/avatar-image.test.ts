import { describe, expect, it, vi } from "vitest";

import {
  avatarGenerationStateMatches,
  avatarGenerationPrompt,
  avatarGenerationRequestSchema,
  generateAvatarImage,
  snapshotAvatarGenerationState,
} from "./avatar-image.ts";

const BOT = { name: "Scout", title: "Research agent", description: "Finds evidence quickly." };

describe("avatar image generation", () => {
  it("bounds free-form direction and keeps the crop brief", () => {
    expect(avatarGenerationRequestSchema.safeParse({ prompt: "x".repeat(401) }).success).toBe(false);
    const prompt = avatarGenerationPrompt(BOT, "navy owl with a brass compass");
    expect(prompt).toContain("center 70%");
    expect(prompt).toContain('"navy owl with a brass compass"');
    expect(prompt).toContain("No words");
  });

  it("detects an avatar edit made after generation starts", () => {
    const mutable = { avatarUrl: "/api/attachments/old.webp", avatarCrop: "circle" as const };
    const initial = snapshotAvatarGenerationState(mutable);

    mutable.avatarUrl = "/api/attachments/new.webp";

    expect(avatarGenerationStateMatches(initial, mutable)).toBe(false);
    expect(initial).toEqual({ avatarUrl: "/api/attachments/old.webp", avatarCrop: "circle" });
  });

  it("uses MiniMax's native image_generation endpoint by default and decodes the PNG bytes it returns", async () => {
    // image-01 emits PNG bytes when `response_format: "base64"`; the bytes
    // themselves don't carry a magic prefix in this fixture but the dispatch
    // contract still says "image/png" so browsers sniffing by magic accept it.
    // MiniMax nests the array under `data.image_base64` (per the official
    // image_generation response shape), unlike OpenAI's flat top-level array.
    const bytes = Buffer.from("generated-png");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: { image_base64: [bytes.toString("base64")] },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await generateAvatarImage("sk-image", BOT, "blue robot", fetchMock);
    expect(result).toEqual({ bytes, mime: "image/png" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.minimax.io/v1/image_generation");
    expect(init?.headers).toMatchObject({ authorization: "Bearer sk-image" });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "image-01",
      response_format: "base64",
      image_size: "1024x1024",
      n: 1,
    });
  });

  it("falls back to the OpenAI data[].b64_json shape if MiniMax ever returns it (defensive)", async () => {
    const bytes = Buffer.from("generated-png");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ b64_json: bytes.toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await generateAvatarImage("sk-image", BOT, "blue robot", fetchMock);
    expect(result).toEqual({ bytes, mime: "image/png" });
  });

  it("still routes to OpenAI gpt-image-2 + webp when the operator picks that provider", async () => {
    const bytes = Buffer.from("generated-webp");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [{ b64_json: bytes.toString("base64") }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await generateAvatarImage("sk-image", BOT, "blue robot", fetchMock, 120_000, "openai");
    expect(result).toEqual({ bytes, mime: "image/webp" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-image-2",
      output_format: "webp",
    });
  });

  it("says to add a MiniMax key when the default provider is selected and no key is set", async () => {
    await expect(generateAvatarImage("", BOT, "blue robot", vi.fn()))
      .rejects.toMatchObject({ message: /MiniMax API key/i, status: 409 });
    await expect(generateAvatarImage("", BOT, "blue robot", vi.fn(), 120_000, "openai"))
      .rejects.toMatchObject({ message: /OpenAI image API key/i, status: 409 });
  });

  it("never exposes malformed upstream bodies as image data", async () => {
    const malformed = vi.fn<typeof fetch>(async () => new Response('{"image_base64":[]}', { status: 200 }));
    await expect(generateAvatarImage("sk-image", BOT, "", malformed))
      .rejects.toThrow("no generated image");
  });

  it("cancels an upstream response as soon as it exceeds the byte cap", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 20) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversized = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));

    await expect(generateAvatarImage("sk-image", BOT, "", oversized))
      .rejects.toThrow("exceeded the response limit");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
  });

  it("normalizes a timeout that fires while reading a hanging response body", async () => {
    const hanging = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });

    await expect(generateAvatarImage("sk-image", BOT, "", hanging, 10)).rejects.toMatchObject({
      message: "Avatar generation timed out",
      status: 502,
    });
  });
});
