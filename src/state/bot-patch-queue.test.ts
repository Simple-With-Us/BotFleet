import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyBotPatch, createBotPatchQueue, mergeBotPatches, type BotUpdatePatch } from "./bot-patch-queue";
import type { Bot, BotAnnouncement } from "./store";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "bot-1",
  threadId: "thread-1",
  name: "Maus",
  title: "Helper",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "fixture", model: "default" },
  messages: [],
  ...overrides,
});

interface DeferredBot {
  promise: Promise<BotAnnouncement>;
  resolve: (value: BotAnnouncement) => void;
  reject: (error: Error) => void;
}

const deferredBot = (): DeferredBot => {
  let resolve!: DeferredBot["resolve"];
  let reject!: DeferredBot["reject"];
  const promise = new Promise<BotAnnouncement>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

describe("bot patch queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces upload then remove so an older avatar can never resurrect", async () => {
    const sent: BotUpdatePatch[] = [];
    const authoritative = vi.fn();
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return applyBotPatch(bot(), patch);
      },
      reconcile: async () => bot(),
      onAuthoritative: authoritative,
      onError: vi.fn(),
    });

    queue.enqueue(
      "bot-1",
      { avatarUrl: "/api/attachments/avatar.webp", avatarCrop: "circle" },
      bot(),
    );
    await vi.advanceTimersByTimeAsync(200);
    queue.enqueue("bot-1", { avatarUrl: null, avatarCrop: "mascot" }, bot());
    await vi.advanceTimersByTimeAsync(399);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toEqual([{ avatarUrl: null, avatarCrop: "mascot" }]);
    expect(authoritative).toHaveBeenLastCalledWith(
      expect.objectContaining({ avatarUrl: null, avatarCrop: "mascot" }),
      {},
    );
  });

  it("serializes in-flight profile edits and overlays only the later values", async () => {
    const first = deferredBot();
    const second = deferredBot();
    const sent: BotUpdatePatch[] = [];
    const authoritative = vi.fn();
    const queue = createBotPatchQueue({
      send: (_botId, patch) => {
        sent.push(patch);
        return sent.length === 1 ? first.promise : second.promise;
      },
      reconcile: async () => bot(),
      onAuthoritative: authoritative,
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { name: "First" }, bot());
    await vi.advanceTimersByTimeAsync(400);
    queue.enqueue(
      "bot-1",
      {
        name: "Second",
        title: "Updated title",
        description: "Updated description",
        notifications: false,
        voice: "voice-2",
        speakReplies: true,
      },
      bot(),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(sent).toEqual([{ name: "First" }]);

    first.resolve(bot({ name: "First" }));
    await vi.runAllTicks();
    await Promise.resolve();
    expect(authoritative).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "First" }),
      expect.objectContaining({ name: "Second", voice: "voice-2", speakReplies: true }),
    );
    expect(sent[1]).toMatchObject({
      name: "Second",
      title: "Updated title",
      description: "Updated description",
      notifications: false,
      voice: "voice-2",
      speakReplies: true,
    });

    second.resolve(bot({ name: "Second", voice: "voice-2", speakReplies: true }));
    await vi.runAllTicks();
    await queue.flush("bot-1");
    expect(authoritative).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "Second", voice: "voice-2", speakReplies: true }),
      {},
    );
  });

  it("reconciles a rejected optimistic profile value to the server bot", async () => {
    const authoritative = vi.fn();
    const onError = vi.fn();
    const serverBot = bot({ name: "Server name" });
    const queue = createBotPatchQueue({
      send: async () => {
        throw new Error("name must be at most 100 characters");
      },
      reconcile: async () => serverBot,
      onAuthoritative: authoritative,
      onError,
    });

    queue.enqueue("bot-1", { name: "x".repeat(101) }, bot());
    await vi.advanceTimersByTimeAsync(400);

    expect(authoritative).toHaveBeenCalledWith(serverBot, {});
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "name must be at most 100 characters" }),
    );
  });

  it("does not restore a bot whose queued mutation was cancelled for deletion", async () => {
    const request = deferredBot();
    const authoritative = vi.fn();
    const queue = createBotPatchQueue({
      send: async () => request.promise,
      reconcile: async () => null,
      onAuthoritative: authoritative,
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { name: "Pending" }, bot());
    await vi.advanceTimersByTimeAsync(400);
    queue.cancel("bot-1");
    request.resolve(bot({ name: "Pending" }));
    await vi.runAllTicks();
    await Promise.resolve();

    expect(authoritative).not.toHaveBeenCalled();
    expect(queue.overlayFor("bot-1")).toEqual({});
  });

  it("does not restore a bot cancelled while a failed mutation is reconciling", async () => {
    const reconciliation = deferredBot();
    const authoritative = vi.fn();
    const onError = vi.fn();
    const reconcile = vi.fn(async () => reconciliation.promise);
    const queue = createBotPatchQueue({
      send: async () => {
        throw new Error("patch failed");
      },
      reconcile,
      onAuthoritative: authoritative,
      onError,
    });

    queue.enqueue("bot-1", { name: "Pending" }, bot());
    await vi.advanceTimersByTimeAsync(400);
    expect(reconcile).toHaveBeenCalledOnce();

    queue.cancel("bot-1");
    reconciliation.resolve(bot({ name: "Server name" }));
    await vi.runAllTicks();
    await Promise.resolve();

    expect(authoritative).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(queue.overlayFor("bot-1")).toEqual({});
  });

  it("carries acknowledgeLocalAuto to the wire but never into a state overlay", async () => {
    // The consent flag is the server's proof the local-auto warning dialog was
    // shown (server/index.ts gate). Coalesced with other edits it must still
    // reach the HTTP body — and must never fold back into renderer bot state.
    const sent: BotUpdatePatch[] = [];
    const overlays: BotUpdatePatch[] = [];
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return bot();
      },
      reconcile: async () => bot(),
      onAuthoritative: (_bot, overlay) => overlays.push(overlay),
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { computers: ["local"], acknowledgeLocalAuto: true }, bot());
    queue.enqueue("bot-1", { title: "Ops" }, bot());
    expect(queue.overlayFor("bot-1")).toEqual({ computers: ["local"], title: "Ops" });
    await vi.advanceTimersByTimeAsync(400);
    await queue.flush("bot-1");

    expect(sent).toEqual([{ computers: ["local"], acknowledgeLocalAuto: true, title: "Ops" }]);
    for (const overlay of overlays) expect(overlay).not.toHaveProperty("acknowledgeLocalAuto");
  });

  it("revive undoes a dispose, so StrictMode's dev probe cannot kill saving", async () => {
    // StrictMode mounts, runs the cleanup once against the same memoized
    // queue, and mounts again. dispose → revive must leave a working queue.
    const sent: BotUpdatePatch[] = [];
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return bot();
      },
      reconcile: async () => bot(),
      onAuthoritative: vi.fn(),
      onError: vi.fn(),
    });

    queue.dispose();
    queue.revive();
    queue.enqueue("bot-1", { title: "still saves" }, bot());
    await vi.advanceTimersByTimeAsync(400);
    await queue.flush("bot-1");
    expect(sent).toEqual([{ title: "still saves" }]);
  });

  it("sends a Mac voice and an iPhone voice made inside one debounce window together", async () => {
    const sent: BotUpdatePatch[] = [];
    const authoritative = vi.fn();
    const queue = createBotPatchQueue({
      send: async (_botId, patch) => {
        sent.push(patch);
        return applyBotPatch(bot({ voices: { iphone: "stored-iphone" } }), patch);
      },
      reconcile: async () => bot(),
      onAuthoritative: authoritative,
      onError: vi.fn(),
    });

    queue.enqueue("bot-1", { voices: { mac: "personal:mac-voice" } }, bot());
    await vi.advanceTimersByTimeAsync(100);
    queue.enqueue("bot-1", { voices: { iphone: "minimax-warm" } }, bot());
    // Pending edits overlay per device, not as one replaced object.
    expect(queue.overlayFor("bot-1")).toEqual({ voices: { mac: "personal:mac-voice", iphone: "minimax-warm" } });
    await vi.advanceTimersByTimeAsync(400);

    expect(sent).toEqual([{ voices: { mac: "personal:mac-voice", iphone: "minimax-warm" } }]);
    expect(authoritative).toHaveBeenLastCalledWith(
      expect.objectContaining({ voices: { mac: "personal:mac-voice", iphone: "minimax-warm" } }),
      {},
    );
  });
});

describe("per-device voice patches", () => {
  it("keeps the device a patch does not name", () => {
    const stored = bot({ voices: { mac: "personal:mac-voice", iphone: "minimax-warm" } });
    expect(applyBotPatch(stored, { voices: { iphone: "minimax-cool" } }).voices).toEqual({
      mac: "personal:mac-voice",
      iphone: "minimax-cool",
    });
  });

  it("clears one device with null and drops the field when none is left", () => {
    const stored = bot({ voices: { mac: "personal:mac-voice" } });
    expect(applyBotPatch(stored, { voices: { mac: null } }).voices).toBeNull();
    expect(applyBotPatch(bot({ voices: null }), { voices: { iphone: "minimax-warm" } }).voices).toEqual({ iphone: "minimax-warm" });
  });

  it("leaves voices alone when the patch does not carry them, and strips the consent flag", () => {
    const stored = bot({ voices: { mac: "personal:mac-voice" } });
    const next = applyBotPatch(stored, { name: "Renamed", acknowledgeLocalAuto: true });
    expect(next.voices).toEqual({ mac: "personal:mac-voice" });
    expect(next.name).toBe("Renamed");
    expect(next).not.toHaveProperty("acknowledgeLocalAuto");
  });

  it("coalesces voices per device and every other field last-write-wins", () => {
    expect(
      mergeBotPatches({ voices: { mac: "a" }, voice: "shared-1" }, { voices: { mac: null, iphone: "b" }, voice: "shared-2" }),
    ).toEqual({ voices: { mac: null, iphone: "b" }, voice: "shared-2" });
  });
});
