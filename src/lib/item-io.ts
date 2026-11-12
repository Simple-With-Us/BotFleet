// Fetching one step's full input and output, on demand.
//
// The transcript and the Trajectory list carry a headline per step; the whole
// payload lives in the harness's side store and is read when a row is opened
// (GET /api/threads/:id/items/:itemId/io).  This module is the client's half:
// the request, the four things that can come back, and a small cache so
// opening a row twice, or scrolling a virtualised list back to one, does not
// read it again.
//
// The cache is what makes the rows render without a flash and what lets a
// test put a row in any state without a network: `primeItemIo` is the same
// door a real response goes through.
import type { ItemIoPayload, BoundedText } from "../../shared/item-io";

/** What asking for a step's input and output can answer. */
export type ItemIoState =
  | { status: "loading" }
  | { status: "loaded"; io: ItemIoPayload }
  /** nothing was recorded: a step from before the store existed, or one that
   * has since rotated out.  Says so; never guesses. */
  | { status: "unavailable" }
  | { status: "error"; message: string };

/** Everything that finds one step's payload. */
export interface ItemIoRef {
  threadId: string;
  itemId: string;
  turnId?: string;
}

export function itemIoKey(ref: ItemIoRef): string {
  return `${ref.threadId}\u0000${ref.turnId ?? ""}\u0000${ref.itemId}`;
}

export function itemIoUrl(ref: ItemIoRef): string {
  const base = `/api/threads/${encodeURIComponent(ref.threadId)}/items/${encodeURIComponent(ref.itemId)}/io`;
  return ref.turnId ? `${base}?turnId=${encodeURIComponent(ref.turnId)}` : base;
}

/** Entries kept.  Each is at most two 32 KB fields; the bound is what keeps a
 * long session of opening rows from becoming a second copy of the side store. */
export const ITEM_IO_CACHE_LIMIT = 64;

const cache = new Map<string, ItemIoState>();
const inflight = new Map<string, Promise<ItemIoState>>();

/** Loaded and unavailable answers are kept; nothing else is. */
function remember(key: string, state: ItemIoState): void {
  if (state.status !== "loaded" && state.status !== "unavailable") return;
  cache.delete(key);
  cache.set(key, state);
  while (cache.size > ITEM_IO_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** What is already known for a step, without asking. */
export function peekItemIo(ref: ItemIoRef): ItemIoState | undefined {
  const key = itemIoKey(ref);
  const hit = cache.get(key);
  if (hit) {
    // a read is a use: keep it young
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** Put an answer in the cache as if the harness had given it. */
export function primeItemIo(ref: ItemIoRef, state: ItemIoState): void {
  remember(itemIoKey(ref), state);
}

export function clearItemIoCache(): void {
  cache.clear();
  inflight.clear();
}

export interface LoadItemIoOptions {
  /** Keep the answer.  False for a step still running: its output has not
   * been written yet, and a cached "unavailable" would outlive the step. */
  cache?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** Ask the harness for one step's full input and output.  Never rejects: a
 * failure is a state the row can show.  Concurrent asks for one step share one
 * request. */
export async function loadItemIo(ref: ItemIoRef, options: LoadItemIoOptions = {}): Promise<ItemIoState> {
  const key = itemIoKey(ref);
  const keep = options.cache !== false;
  if (keep) {
    const known = peekItemIo(ref);
    if (known) return known;
  }
  const pending = inflight.get(key);
  if (pending && !options.signal) return pending;
  const request = (async (): Promise<ItemIoState> => {
    try {
      const res = await (options.fetchImpl ?? fetch)(itemIoUrl(ref), { signal: options.signal });
      if (res.status === 404) return { status: "unavailable" };
      if (!res.ok) return { status: "error", message: `The harness answered ${res.status}` };
      const io = (await res.json()) as ItemIoPayload;
      return { status: "loaded", io };
    } catch (e) {
      return { status: "error", message: e instanceof Error ? e.message : String(e) };
    }
  })();
  if (!options.signal) {
    inflight.set(key, request);
    void request.finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  }
  const state = await request;
  if (keep && !options.signal?.aborted) remember(key, state);
  return state;
}

const count = new Intl.NumberFormat("en-US");

/** The one line under a cut field: what is shown, of how much. */
export function truncationNote(field: Pick<BoundedText, "text" | "length">): string {
  return `Truncated — showing first ${count.format(field.text.length)} of ${count.format(field.length)} characters`;
}

/** The ref for a transcript tool row, or null when the row has no key (a step
 * recorded before the harness kept one) or the view does not know its thread. */
export function itemIoRefOf(
  threadId: string | undefined,
  tool: { itemId?: string; turnId?: string } | undefined,
): ItemIoRef | null {
  if (!threadId || !tool?.itemId) return null;
  return { threadId, itemId: tool.itemId, ...(tool.turnId ? { turnId: tool.turnId } : {}) };
}
