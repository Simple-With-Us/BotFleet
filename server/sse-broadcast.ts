// SSE fan-out backpressure and replay-buffer bookkeeping, split out of
// index.ts so the write()===false backpressure path and the replay
// buffer's byte-cap eviction — both hard to exercise through a real
// socket without genuinely stalling a client — get a fast, deterministic
// unit test instead of only the process-level HTTP suite (HS16, HS17).

/** The exact surface `broadcast()` needs from a response: matches
 * http.ServerResponse (itself a stream.Writable), so the real handler
 * needs no adapter and a test can hand in a plain object. */
export interface SseWritable {
  write(chunk: string): boolean;
  end(): void;
  /** Bytes queued for the underlying transport but not yet flushed. */
  writableLength: number;
  /** Whether the underlying connection is already gone — checked by the
   * live-viewer probe that decides whether to keep polling a screen. */
  destroyed: boolean;
}

/** One connected client, and what it asked to be sent. */
export interface SseClient {
  res: SseWritable;
  /** Live screen frames carry a base64 desktop capture every few seconds
   * while a bot works. A client that isn't showing the computer panel —
   * a phone on cellular, most of all — should not pay for them. */
  screens: boolean;
  screenBotIds: Set<string> | null;
  /** true once write() last signalled backpressure; cleared on the
   * response's own 'drain' event. While true, screen frames are skipped
   * for this client instead of queuing without bound (HS16). */
  slow: boolean;
}

/** Screen frames are the only kind a client can decline. */
export const wants = (client: Pick<SseClient, "screens">, kind: string): boolean => kind !== "screen" || client.screens;

/** A slow client's write queue past this many buffered bytes is
 * disconnected outright rather than left to grow — a phone on cellular
 * that stops draining while screen frames stream every few seconds would
 * otherwise buffer without bound in the harness heap. The client
 * reconnects and resumes from its cursor, same as any other drop. */
export const SLOW_CLIENT_BYTE_LIMIT = 8 * 1024 * 1024; // 8 MB

export type SseWriteResult = "wrote" | "dropped" | "slow-end" | "error";

/** One fan-out write attempt to one client. Mutates `client.slow`.
 *
 * Returns "dropped" when the frame was filtered (the client never wanted
 * this kind, or it is a screen frame outside the client's subscribed bot
 * set) or skipped outright for a slow client's droppable kind; "slow-end"
 * when the client's buffered bytes just crossed SLOW_CLIENT_BYTE_LIMIT and
 * its connection was closed; "error" when the underlying write threw (an
 * already-dead socket); "wrote" otherwise. Never throws.
 *
 * Screens are the one frame kind safe to drop for a slow client: the
 * client already re-fetches a screen message's pixels by id on demand, so
 * a skipped live frame costs it nothing but staleness. Every other kind
 * (chat messages, tool activity, turn state) carries data with no other
 * path to the client, so it is never dropped — a client that cannot keep
 * up with those instead hits the byte ceiling and is disconnected. */
export function writeToClient(client: SseClient, frame: string, kind: string, botId: string): SseWriteResult {
  if (!wants(client, kind)) return "dropped";
  if (kind === "screen" && client.screenBotIds && !client.screenBotIds.has(botId)) return "dropped";
  if (client.slow && kind === "screen") return "dropped";
  try {
    const ok = client.res.write(frame);
    if (!ok) client.slow = true;
    if (client.res.writableLength > SLOW_CLIENT_BYTE_LIMIT) {
      client.res.end();
      return "slow-end";
    }
    return "wrote";
  } catch {
    return "error";
  }
}

export interface ReplayEntry {
  seq: number;
  kind: string;
  frame: string | null;
}

/** The last few hundred frames, so a client whose connection dropped can
 * ask for what it missed instead of re-downloading every transcript.
 * Bounded by count AND by bytes: screen frames are dropped from the
 * buffer's own payload (a client's own live frame is always fresher than
 * a replayed one), but nothing else was, so 500 long `message` frames — a
 * big tool result, a long reply — was still unbounded heap (HS17). */
export class ReplayBuffer {
  readonly entries: ReplayEntry[] = [];
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries: number, maxBytes: number) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  /** Evicts oldest first past either cap. A client whose cursor fell out
   * of the buffer either way gets the same "hydrate instead" signal,
   * since resume only looks at the oldest remaining seq — eviction
   * reason never changes that semantics. */
  push(seq: number, kind: string, frame: string): void {
    const kept = kind === "screen" ? null : frame;
    this.entries.push({ seq, kind, frame: kept });
    if (kept) this.bytes += Buffer.byteLength(kept, "utf8");
    while (this.entries.length > 0 && (this.entries.length > this.maxEntries || this.bytes > this.maxBytes)) {
      const dropped = this.entries.shift()!;
      if (dropped.frame) this.bytes -= Buffer.byteLength(dropped.frame, "utf8");
    }
  }
}
