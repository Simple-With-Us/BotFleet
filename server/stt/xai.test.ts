import { afterEach, describe, expect, it, vi } from "vitest";

import { XAI_STT_MODEL, XAI_STT_REST_URL, buildXaiSttStreamingUrl } from "../../shared/xai-stt.ts";
import { transcribeFile, openStreamingSession } from "./xai.ts";
import { createXaiSttSession, appendXaiSttAudio, subscribeXaiSttSession, stopXaiSttSession, resetXaiSttSessions } from "./sessions.ts";
import type { AuthorizedWs, AuthorizedWsHandlers } from "./authorized-ws.ts";
import type { XaiSttServerEvent } from "../../shared/xai-stt.ts";

afterEach(async () => {
  await resetXaiSttSessions();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("transcribeFile", () => {
  it("posts multipart audio with the documented model, language, and keyterms", async () => {
    const calls: Array<{ url: string; headers: Headers; form: FormData }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!(init?.body instanceof FormData)) throw new Error("expected multipart body");
      calls.push({ url, headers: new Headers(init?.headers), form: init.body });
      return new Response(JSON.stringify({ text: "Hello fleet", duration: 1.5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await transcribeFile("sk-test", {
      bytes: new Uint8Array([1, 2, 3, 4]),
      filename: "clip.wav",
      mime: "audio/wav",
      language: "en-US",
      keyterms: ["BotFleet"],
    }, { fetchImpl });
    expect(result).toEqual({ text: "Hello fleet", duration: 1.5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(XAI_STT_REST_URL);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(calls[0]!.form.get("model")).toBe(XAI_STT_MODEL);
    expect(calls[0]!.form.get("language")).toBe("en");
    expect(calls[0]!.form.get("format")).toBe("true");
    expect(calls[0]!.form.getAll("keyterm")).toEqual(["BotFleet"]);
    const file = calls[0]!.form.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error("expected a File part");
    expect(file.name).toBe("clip.wav");
  });

  it("maps a rejected key to a clear error", async () => {
    const fetchImpl: typeof fetch = async () => new Response("", { status: 401 });
    await expect(transcribeFile("bad", {
      bytes: new Uint8Array([1]),
      filename: "clip.wav",
    }, { fetchImpl })).rejects.toThrow(/rejected this API key/i);
  });
});

function fakeSocket() {
  let handlers: AuthorizedWsHandlers = {};
  const sentBinary: Uint8Array[] = [];
  const sentText: string[] = [];
  const socket: AuthorizedWs = {
    readyState: 1,
    sendText(text) { sentText.push(text); },
    sendBinary(data) { sentBinary.push(data); },
    close() { handlers.onClose?.(); },
  };
  const open = async (_url: string, _headers: Record<string, string>, next: AuthorizedWsHandlers) => {
    handlers = next;
    queueMicrotask(() => handlers.onMessage?.(JSON.stringify({ type: "transcript.created" })));
    return socket;
  };
  return {
    open,
    sentBinary,
    sentText,
    emit: (payload: XaiSttServerEvent) => handlers.onMessage?.(JSON.stringify(payload)),
    hangup: () => handlers.onClose?.(),
  };
}

describe("openStreamingSession", () => {
  it("waits for transcript.created, forwards audio, and finishes with audio.done", async () => {
    const fake = fakeSocket();
    const partials: Array<{ text: string; final: boolean }> = [];
    const session = await openStreamingSession("sk-test", { language: "en", endpointingMs: 850 }, {
      onPartial: (text, final) => partials.push({ text, final }),
    }, { openSocket: fake.open });
    session.sendAudio(new Uint8Array([0, 1, 2]));
    expect(fake.sentBinary[0]).toBeInstanceOf(Uint8Array);
    fake.emit({ type: "transcript.partial", text: "Hello", speech_final: false });
    fake.emit({ type: "transcript.partial", text: "Hello there", speech_final: true });
    const finished = session.finish();
    fake.emit({ type: "transcript.done", duration: 1.25 });
    await finished;
    expect(partials).toEqual([
      { text: "Hello", final: false },
      { text: "Hello there", final: true },
    ]);
    expect(fake.sentText.at(-1)).toContain("audio.done");
  });

  it("opens the documented streaming URL", async () => {
    let opened = "";
    const fake = fakeSocket();
    const open = async (url: string, headers: Record<string, string>, handlers: AuthorizedWsHandlers) => {
      opened = url;
      expect(headers.Authorization).toBe("Bearer sk-test");
      return fake.open(url, headers, handlers);
    };
    const session = await openStreamingSession("sk-test", { language: "en", keyterms: ["BotFleet"] }, {}, { openSocket: open });
    expect(opened).toBe(buildXaiSttStreamingUrl({ language: "en", keyterms: ["BotFleet"] }));
    session.close();
  });

  it("notifies onDone when the socket closes cleanly without transcript.done", async () => {
    const fake = fakeSocket();
    const done: Array<number | undefined> = [];
    const errors: string[] = [];
    await openStreamingSession("sk-test", { language: "en" }, {
      onDone: (duration) => done.push(duration),
      onError: (message) => errors.push(message),
    }, { openSocket: fake.open });
    fake.hangup();
    expect(errors).toEqual([]);
    expect(done).toHaveLength(1);
  });
});

describe("session store", () => {
  it("forwards audio and subscriber events", async () => {
    const fake = fakeSocket();
    const id = await createXaiSttSession({ apiKey: "sk-test", params: { language: "en" }, openSocket: fake.open });
    const events: Array<{ type: string }> = [];
    const off = subscribeXaiSttSession(id, (event) => events.push(event));
    expect(off).toBeTypeOf("function");
    expect(appendXaiSttAudio(id, new Uint8Array([9, 8]))).toBe(true);
    fake.emit({ type: "transcript.partial", text: "Hi", speech_final: true });
    await stopXaiSttSession(id);
    expect(events.some((event) => event.type === "partial")).toBe(true);
    expect(appendXaiSttAudio(id, new Uint8Array([1]))).toBe(false);
  });
});
