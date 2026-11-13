import {
  XAI_STT_MODEL,
  XAI_STT_REST_URL,
  XaiSttFileResultSchema,
  XaiSttHttpErrorSchema,
  buildXaiSttStreamingUrl,
  cleanXaiKeyterms,
  normalizeXaiSttLanguage,
  parseXaiSttEvent,
  XaiSttWireEventSchema,
  xaiPartialToTurn,
  type XaiSttFileResult,
  type XaiSttStreamingParams,
} from "../../shared/xai-stt.ts";
import { openAuthorizedWebSocket, type AuthorizedWs, type AuthorizedWsOpener } from "./authorized-ws.ts";
import { recordSttUsage } from "./usage.ts";

export interface XaiSttFileInput {
  bytes: Uint8Array;
  filename: string;
  mime?: string;
  language?: string;
  keyterms?: readonly string[];
  model?: string;
}

export interface XaiSttStreamHandlers {
  onReady?: () => void;
  onPartial?: (text: string, final: boolean) => void;
  onDone?: (duration?: number) => void;
  onError?: (message: string) => void;
}

export interface XaiSttStreamSession {
  sendAudio(bytes: Uint8Array): void;
  finish(): Promise<void>;
  close(): void;
}

function finiteDuration(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const trimmed = body.trim();
  if (!trimmed) return `xAI speech-to-text failed (HTTP ${response.status}).`;
  try {
    const parsed = XaiSttHttpErrorSchema.safeParse(JSON.parse(trimmed));
    const message = parsed.success ? (parsed.data.message ?? parsed.data.error)?.trim() : "";
    if (message) return message;
  } catch {
    // Body was not JSON; fall through to a short excerpt.
  }
  return trimmed.slice(0, 200);
}

/** REST file transcription: POST https://api.x.ai/v1/stt (multipart). */
export async function transcribeFile(
  apiKey: string,
  input: XaiSttFileInput,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<XaiSttFileResult> {
  const secret = apiKey.trim();
  if (!secret) throw new Error("Add an xAI API key in Connections before transcribing.");
  if (!input.bytes.byteLength) throw new Error("Audio is empty.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const form = new FormData();
  const model = input.model?.trim() || XAI_STT_MODEL;
  form.append("model", model);
  const language = normalizeXaiSttLanguage(input.language);
  if (language) {
    form.append("language", language);
    form.append("format", "true");
  }
  for (const term of cleanXaiKeyterms(input.keyterms)) form.append("keyterm", term);
  const mime = input.mime?.trim() || "application/octet-stream";
  form.append("file", new Blob([Uint8Array.from(input.bytes)], { type: mime }), input.filename || "audio.wav");
  let response: Response;
  try {
    response = await fetchImpl(XAI_STT_REST_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error("Could not reach xAI to transcribe. Check this computer's network connection.");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("xAI rejected this API key.");
    throw new Error(await readError(response));
  }
  const parsed = XaiSttFileResultSchema.safeParse(await response.json().catch(() => null));
  const text = parsed.success ? (parsed.data.text ?? "") : "";
  const duration = parsed.success ? finiteDuration(parsed.data.duration) : undefined;
  recordSttUsage("xai", duration ?? 0, "rest", { service: "xai-stt" });
  return { text, duration };
}

/** Open a streaming session to wss://api.x.ai/v1/stt.  Wait for
 *  transcript.created before sendAudio.  The API key stays in this process. */
export async function openStreamingSession(
  apiKey: string,
  params: XaiSttStreamingParams,
  handlers: XaiSttStreamHandlers,
  options: { openSocket?: AuthorizedWsOpener } = {},
): Promise<XaiSttStreamSession> {
  const secret = apiKey.trim();
  if (!secret) throw new Error("Add an xAI API key in Connections before starting dictation.");
  const openSocket = options.openSocket ?? openAuthorizedWebSocket;
  const url = buildXaiSttStreamingUrl(params);
  const startedAt = Date.now();
  let recorded = false;
  let closed = false;
  let ready = false;
  let notified = false;
  let lastDuration: number | undefined;
  let socket: AuthorizedWs | undefined;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveDone: () => void = () => {};
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const record = () => {
    if (recorded) return;
    recorded = true;
    const elapsed = (Date.now() - startedAt) / 1000;
    recordSttUsage("xai", lastDuration ?? elapsed, "streaming", { service: "xai-stt-streaming" });
  };
  const notify = (kind: "done" | "error", message?: string) => {
    if (notified) return;
    notified = true;
    closed = true;
    record();
    if (kind === "error") handlers.onError?.(message || "xAI speech-to-text failed.");
    else handlers.onDone?.(lastDuration);
    resolveDone();
  };

  socket = await openSocket(url, { Authorization: `Bearer ${secret}` }, {
    onMessage: (data) => {
      let parsedJson: ReturnType<typeof JSON.parse>;
      try { parsedJson = JSON.parse(data); } catch { return; }
      const wire = XaiSttWireEventSchema.safeParse(parsedJson);
      if (!wire.success) return;
      const event = parseXaiSttEvent(wire.data);
      if (!event) return;
      if (event.type === "transcript.created") {
        ready = true;
        resolveReady();
        handlers.onReady?.();
        return;
      }
      if (event.type === "transcript.partial") {
        const turn = xaiPartialToTurn(event);
        if (!turn) return;
        handlers.onPartial?.(turn.text, turn.final);
        const duration = finiteDuration(event.duration);
        if (duration !== undefined) lastDuration = duration;
        return;
      }
      if (event.type === "transcript.done") {
        const duration = finiteDuration(event.duration);
        if (duration !== undefined) lastDuration = duration;
        notify("done");
        return;
      }
      if (event.type === "error") {
        const message = event.message?.trim() || "xAI speech-to-text failed.";
        if (!ready) rejectReady(new Error(message));
        notify("error", message);
      }
    },
    onError: (error) => {
      const message = error.message || "Could not reach xAI speech-to-text.";
      if (!ready) rejectReady(new Error(message));
      notify("error", message);
    },
    onClose: () => {
      closed = true;
      if (ready) notify("done");
      else notify("error", "xAI speech-to-text closed before the session finished.");
    },
  });

  const timeout = setTimeout(() => {
    if (!ready) rejectReady(new Error("xAI speech-to-text took too long to start."));
  }, 10_000);
  try {
    await readyPromise;
  } catch (error) {
    clearTimeout(timeout);
    socket.close();
    throw error;
  }
  clearTimeout(timeout);

  return {
    sendAudio(bytes) {
      if (closed || !bytes.byteLength) return;
      socket?.sendBinary(bytes);
    },
    async finish() {
      if (closed) return;
      try { socket?.sendText(JSON.stringify({ type: "audio.done" })); } catch { /* already closed */ }
      const timer = setTimeout(() => resolveDone(), 2_500);
      await donePromise;
      clearTimeout(timer);
      socket?.close();
    },
    close() {
      closed = true;
      record();
      socket?.close();
      resolveDone();
    },
  };
}
