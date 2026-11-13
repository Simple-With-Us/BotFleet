import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ITEM_IO_CACHE_LIMIT,
  clearItemIoCache,
  itemIoKey,
  itemIoRefOf,
  itemIoUrl,
  loadItemIo,
  peekItemIo,
  primeItemIo,
  truncationNote,
  type ItemIoRef,
} from "./item-io";
import type { ItemIoPayload } from "../../shared/item-io";

afterEach(() => clearItemIoCache());

const ref: ItemIoRef = { threadId: "thread-1", itemId: "toolu_1", turnId: "turn-1" };
const payload: ItemIoPayload = {
  itemId: "toolu_1",
  turnId: "turn-1",
  at: "2026-09-30T20:00:00.000Z",
  input: { text: '{\n  "command": "ls"\n}', truncated: false, length: 20 },
  output: { text: "a.ts", truncated: false, length: 4 },
};
const answering = (status: number, body: unknown = payload) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("itemIoUrl", () => {
  it("encodes every segment, because item ids are whatever a provider minted", () => {
    expect(itemIoUrl({ threadId: "t-1", itemId: 'conv "1":step/2' })).toBe(
      "/api/threads/t-1/items/conv%20%221%22%3Astep%2F2/io",
    );
  });

  it("narrows to the turn when it knows one", () => {
    expect(itemIoUrl(ref)).toBe("/api/threads/thread-1/items/toolu_1/io?turnId=turn-1");
  });
});

describe("loadItemIo", () => {
  it("loads what the harness recorded", async () => {
    const fetchImpl = answering(200);
    expect(await loadItemIo(ref, { fetchImpl })).toEqual({ status: "loaded", io: payload });
    expect(fetchImpl).toHaveBeenCalledWith("/api/threads/thread-1/items/toolu_1/io?turnId=turn-1", { signal: undefined });
  });

  it("says unavailable for a step that was never recorded", async () => {
    expect(await loadItemIo(ref, { fetchImpl: answering(404, { error: "nope" }) })).toEqual({ status: "unavailable" });
  });

  it("turns a failure into a state the row can show, and never rejects", async () => {
    expect(await loadItemIo(ref, { fetchImpl: answering(500, {}) })).toEqual({
      status: "error",
      message: "The harness answered 500",
    });
    const offline = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await loadItemIo({ ...ref, itemId: "other" }, { fetchImpl: offline })).toEqual({ status: "error", message: "offline" });
  });

  it("reads a step once, then answers from memory", async () => {
    const fetchImpl = answering(200);
    await loadItemIo(ref, { fetchImpl });
    await loadItemIo(ref, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(peekItemIo(ref)).toEqual({ status: "loaded", io: payload });
  });

  it("remembers a step that was never recorded, so reopening it does not ask again", async () => {
    const fetchImpl = answering(404, {});
    await loadItemIo(ref, { fetchImpl });
    await loadItemIo(ref, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failure, so the next open tries again", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    expect((await loadItemIo(ref, { fetchImpl })).status).toBe("error");
    expect((await loadItemIo(ref, { fetchImpl })).status).toBe("loaded");
  });

  it("does not keep the answer for a step still running", async () => {
    const fetchImpl = answering(404, {});
    await loadItemIo(ref, { fetchImpl, cache: false });
    expect(peekItemIo(ref)).toBeUndefined();
    await loadItemIo(ref, { fetchImpl, cache: false });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent opens of the same step", async () => {
    const fetchImpl = answering(200);
    const [a, b] = await Promise.all([loadItemIo(ref, { fetchImpl }), loadItemIo(ref, { fetchImpl })]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps two turns that reuse an item id apart", async () => {
    const fetchImpl = answering(200);
    await loadItemIo(ref, { fetchImpl });
    await loadItemIo({ ...ref, turnId: "turn-2" }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not remember an answer whose request was cancelled", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as unknown as typeof fetch;
    await loadItemIo(ref, { fetchImpl, signal: controller.signal });
    expect(peekItemIo(ref)).toBeUndefined();
  });
});

describe("the cache", () => {
  it("is primed the way a real answer arrives, which is how a test puts a row in any state", () => {
    primeItemIo(ref, { status: "loaded", io: payload });
    expect(peekItemIo(ref)).toEqual({ status: "loaded", io: payload });
    primeItemIo({ ...ref, itemId: "b" }, { status: "loading" });
    expect(peekItemIo({ ...ref, itemId: "b" })).toBeUndefined();
  });

  it("is bounded, and evicts the step opened longest ago", () => {
    for (let i = 0; i < ITEM_IO_CACHE_LIMIT; i += 1) primeItemIo({ ...ref, itemId: `item-${i}` }, { status: "unavailable" });
    // reading item-0 makes it the youngest
    peekItemIo({ ...ref, itemId: "item-0" });
    primeItemIo({ ...ref, itemId: "one-more" }, { status: "unavailable" });
    expect(peekItemIo({ ...ref, itemId: "item-0" })).toBeDefined();
    expect(peekItemIo({ ...ref, itemId: "item-1" })).toBeUndefined();
  });

  it("keys on thread, turn and item", () => {
    expect(itemIoKey(ref)).not.toBe(itemIoKey({ ...ref, threadId: "thread-2" }));
    expect(itemIoKey(ref)).not.toBe(itemIoKey({ ...ref, turnId: undefined }));
  });
});

describe("truncationNote", () => {
  it("says what is shown, of how much", () => {
    expect(truncationNote({ text: "x".repeat(32768), length: 2_410_118 })).toBe(
      "Truncated — showing first 32,768 of 2,410,118 characters",
    );
  });
});

describe("itemIoRefOf", () => {
  it("builds the key from a tool row and its thread", () => {
    expect(itemIoRefOf("t", { itemId: "i", turnId: "u" })).toEqual({ threadId: "t", itemId: "i", turnId: "u" });
    expect(itemIoRefOf("t", { itemId: "i" })).toEqual({ threadId: "t", itemId: "i" });
  });

  it("is null for a row recorded before the harness kept a key, or a view with no thread", () => {
    expect(itemIoRefOf("t", {})).toBeNull();
    expect(itemIoRefOf("t", undefined)).toBeNull();
    expect(itemIoRefOf(undefined, { itemId: "i" })).toBeNull();
  });
});
