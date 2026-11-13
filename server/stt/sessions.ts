import { randomUUID } from "node:crypto";

import type { XaiSttStreamingParams } from "../../shared/xai-stt.ts";
import { openStreamingSession, type XaiSttStreamSession } from "./xai.ts";
import type { AuthorizedWsOpener } from "./authorized-ws.ts";

export interface SttListener {
  (event: SttSessionEvent): void;
}

export type SttSessionEvent =
  | { type: "ready" }
  | { type: "partial"; text: string; final: boolean }
  | { type: "done"; duration?: number }
  | { type: "error"; message: string };

interface LiveSession {
  id: string;
  stream: XaiSttStreamSession;
  listeners: Set<SttListener>;
  timer: NodeJS.Timeout;
  pending: SttSessionEvent[];
}

const MAX_SESSIONS = 8;
const IDLE_MS = 8 * 60 * 1000;
const sessions = new Map<string, LiveSession>();

function emit(live: LiveSession, event: SttSessionEvent): void {
  if (live.listeners.size === 0) {
    live.pending.push(event);
    return;
  }
  for (const listener of live.listeners) {
    try { listener(event); } catch { /* one bad subscriber must not drop the rest */ }
  }
}

function touch(live: LiveSession): void {
  clearTimeout(live.timer);
  live.timer = setTimeout(() => {
    void drop(live.id, "idle").catch(() => {});
  }, IDLE_MS);
}

async function drop(id: string, _reason: "idle" | "stop"): Promise<void> {
  const live = sessions.get(id);
  if (!live) return;
  sessions.delete(id);
  clearTimeout(live.timer);
  try { live.stream.close(); } catch { /* best-effort */ }
}

export interface CreateXaiSessionOptions {
  apiKey: string;
  params: XaiSttStreamingParams;
  openSocket?: AuthorizedWsOpener;
}

export async function createXaiSttSession(options: CreateXaiSessionOptions): Promise<string> {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error("Too many live voice-dictation sessions. End one and try again.");
  }
  const id = randomUUID();
  const listeners = new Set<SttListener>();
  const early: SttSessionEvent[] = [];
  const deliver = (event: SttSessionEvent) => {
    const live = sessions.get(id);
    if (live) emit(live, event);
    else early.push(event);
  };
  const stream = await openStreamingSession(options.apiKey, options.params, {
    onReady: () => deliver({ type: "ready" }),
    onPartial: (text, final) => {
      const live = sessions.get(id);
      if (live) touch(live);
      deliver({ type: "partial", text, final });
    },
    onDone: (duration) => {
      deliver({ type: "done", duration });
      void drop(id, "stop").catch(() => {});
    },
    onError: (message) => {
      deliver({ type: "error", message });
      void drop(id, "stop").catch(() => {});
    },
  }, { openSocket: options.openSocket });
  const live: LiveSession = {
    id,
    stream,
    listeners,
    pending: [],
    timer: setTimeout(() => { void drop(id, "idle").catch(() => {}); }, IDLE_MS),
  };
  sessions.set(id, live);
  for (const event of early) emit(live, event);
  return id;
}

export function appendXaiSttAudio(id: string, bytes: Uint8Array): boolean {
  const live = sessions.get(id);
  if (!live) return false;
  touch(live);
  live.stream.sendAudio(bytes);
  return true;
}

export function subscribeXaiSttSession(id: string, listener: SttListener): (() => void) | null {
  const live = sessions.get(id);
  if (!live) return null;
  live.listeners.add(listener);
  const queued = live.pending.splice(0);
  for (const event of queued) {
    try { listener(event); } catch { /* one bad subscriber must not drop the rest */ }
  }
  return () => { live.listeners.delete(listener); };
}

export async function stopXaiSttSession(id: string): Promise<boolean> {
  const live = sessions.get(id);
  if (!live) return false;
  try { await live.stream.finish(); } catch { /* already closing */ }
  await drop(id, "stop");
  return true;
}

/** Test hook: drop every live session. */
export async function resetXaiSttSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  for (const id of ids) await drop(id, "stop");
}
