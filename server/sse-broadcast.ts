// SSE fan-out backpressure and replay-buffer bookkeeping, split out of
// index.ts so the write()===false backpressure path and the replay
// buffer's byte-cap eviction — both hard to exercise through a real
// socket without genuinely stalling a client — get a fast, deterministic
// unit test instead of only the process-level HTTP suite (HS16, HS17).

import { z } from "zod";

export const SSE_FILTER_MAX_VALUES = 32;
export const SSE_BOT_ID_MAX_VALUES = 1024;
export const SSE_FILTER_VALUE_MAX_LENGTH = 128;

/** Bounded validation schema for repeated SSE query allowlists (`?kind=`, `?threadId=`). */
export const SseFilterListSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "SSE filter value must not be empty")
      .max(SSE_FILTER_VALUE_MAX_LENGTH, `SSE filter value must be at most ${SSE_FILTER_VALUE_MAX_LENGTH} characters`)
      .regex(/^[A-Za-z0-9_.:-]+$/, "SSE filter value contains invalid characters"),
  )
  .max(SSE_FILTER_MAX_VALUES, `At most ${SSE_FILTER_MAX_VALUES} SSE filter values are allowed`);

export type SseFilterList = z.infer<typeof SseFilterListSchema>;

/** Bounded validation schema for repeated SSE screen-watcher `?botId=` allowlists. */
export const SseBotIdListSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "SSE botId filter value must not be empty")
      .max(SSE_FILTER_VALUE_MAX_LENGTH, `SSE botId filter value must be at most ${SSE_FILTER_VALUE_MAX_LENGTH} characters`),
  )
  .max(SSE_BOT_ID_MAX_VALUES, `At most ${SSE_BOT_ID_MAX_VALUES} SSE botId filter values are allowed`);

export type SseBotIdList = z.infer<typeof SseBotIdListSchema>;

/** Strict boundary schema for `/api/events` subscription filter query parameters. */
export const SseFiltersQuerySchema = z
  .object({
    botId: SseBotIdListSchema.optional(),
    kind: SseFilterListSchema.optional(),
    threadId: SseFilterListSchema.optional(),
  })
  .strict();

export type SseFiltersQuery = z.infer<typeof SseFiltersQuerySchema>;

export type SseFilterParseResult =
  | { ok: true; values: Set<string> | null }
  | { ok: false; message: string };

/** Validate one repeated SSE filter query parameter (`?kind=`, `?threadId=`). */
export function parseSseFilterParam(searchParams: URLSearchParams, name: string): SseFilterParseResult {
  if (!searchParams.has(name)) return { ok: true, values: null };
  const parsed = SseFilterListSchema.safeParse(searchParams.getAll(name));
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? `Invalid SSE ${name} filter`,
    };
  }
  return { ok: true, values: new Set(parsed.data) };
}

export interface SseFrameEnvelope {
  botId?: string;
  threadId?: string;
  bot?: { id?: string; threadId?: string };
  group?: { threadId?: string };
  event?: { threadId?: string };
}

export interface SseFrameTarget {
  botId: string;
  threadId: string;
}

/** Derive the canonical `(botId, threadId)` target from top-level or nested SSE frame envelopes. */
export function extractSseFrameTarget(payload: SseFrameEnvelope): SseFrameTarget {
  const botId = String(payload.botId ?? payload.bot?.id ?? "");
  const threadId = String(
    payload.threadId ??
      payload.event?.threadId ??
      payload.bot?.threadId ??
      payload.group?.threadId ??
      "",
  );
  return { botId, threadId };
}

export type SseFiltersParseResult =
  | { ok: true; screenBotIds: Set<string> | null; onlyKinds: Set<string> | null; threadIds: Set<string> | null }
  | { ok: false; message: string };

interface SseFiltersQueryInput {
  botId?: string[];
  kind?: string[];
  threadId?: string[];
}

/** Parse and validate `/api/events` SSE subscription allowlists (`?botId=`, `?kind=`, `?threadId=`). */
export function parseSseFilters(searchParams: URLSearchParams): SseFiltersParseResult {
  const raw: SseFiltersQueryInput = {};
  if (searchParams.has("botId")) raw.botId = searchParams.getAll("botId");
  if (searchParams.has("kind")) raw.kind = searchParams.getAll("kind");
  if (searchParams.has("threadId")) raw.threadId = searchParams.getAll("threadId");
  const parsed = SseFiltersQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Invalid SSE filter",
    };
  }
  return {
    ok: true,
    screenBotIds: parsed.data.botId ? new Set(parsed.data.botId) : null,
    onlyKinds: parsed.data.kind ? new Set(parsed.data.kind) : null,
    threadIds: parsed.data.threadId ? new Set(parsed.data.threadId) : null,
  };
}

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
  /** Optional kind allowlist (`?kind=...`). When non-null, only listed frame kinds
   * are delivered or replayed; an empty Set delivers no frames. */
  onlyKinds?: Set<string> | null;
  /** Optional thread allowlist (`?threadId=...`). When non-null, only frames bound
   * to a listed thread are delivered or replayed; an empty Set delivers no frames. */
  threadIds?: Set<string> | null;
  /** true once write() last signalled backpressure; cleared on the
   * response's own 'drain' event. While true, screen frames are skipped
   * for this client instead of queuing without bound (HS16). */
  slow: boolean;
}

/** Whether a client wants frames of `kind`. */
export const wants = (client: Pick<SseClient, "screens" | "onlyKinds">, kind: string): boolean =>
  (kind !== "screen" || client.screens) && (!client.onlyKinds || client.onlyKinds.has(kind));

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
export function writeToClient(
  client: SseClient,
  frame: string,
  kind: string,
  botId: string,
  threadId = "",
): SseWriteResult {
  if (!wants(client, kind)) return "dropped";
  if (client.threadIds && (!threadId || !client.threadIds.has(threadId))) return "dropped";
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

/** Frame kinds where only the newest one is worth replaying. */
const LATEST_ONLY_KINDS = new Set(["instances"]);

export interface ReplayEntry {
  seq: number;
  kind: string;
  frame: string | null;
  threadId?: string;
}

/** Whether a buffered replay entry satisfies the reconnecting client's kind,
 * screen, and thread subscriptions. */
export function wantsReplayEntry(
  client: Pick<SseClient, "screens" | "onlyKinds" | "threadIds">,
  entry: ReplayEntry,
): boolean {
  if (!entry.frame || !wants(client, entry.kind)) return false;
  if (client.threadIds && (!entry.threadId || !client.threadIds.has(entry.threadId))) return false;
  return true;
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
  push(seq: number, kind: string, frame: string, threadId?: string): void {
    const kept = kind === "screen" ? null : frame;
    // A whole engine list (~25 KB) supersedes the one before it: replaying an
    // older list to a client that will also get this one only spends the
    // byte budget that message frames need.  Keep the slot, drop the payload.
    if (LATEST_ONLY_KINDS.has(kind)) {
      for (const entry of this.entries) {
        if (entry.kind !== kind || !entry.frame) continue;
        this.bytes -= Buffer.byteLength(entry.frame, "utf8");
        entry.frame = null;
      }
    }
    this.entries.push(threadId ? { seq, kind, frame: kept, threadId } : { seq, kind, frame: kept });
    if (kept) this.bytes += Buffer.byteLength(kept, "utf8");
    while (this.entries.length > 0 && (this.entries.length > this.maxEntries || this.bytes > this.maxBytes)) {
      const dropped = this.entries.shift()!;
      if (dropped.frame) this.bytes -= Buffer.byteLength(dropped.frame, "utf8");
    }
  }
}
