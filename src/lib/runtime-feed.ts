// A door for the runtime events the app's one event stream already receives.
//
// The store folds `content.delta` and `turn.completed` into chat state and
// lets everything else fall on the floor.  The Trajectory tab wants the rest —
// tool starts and ends, reasoning, usage — but must not make the whole app
// re-render for them, and must cost nothing when it is not open.  So the store
// hands each event here, and this does nothing at all unless a view has
// subscribed to that thread.
//
// Streamed `content.delta` events are dropped rather than forwarded: a
// paragraph is hundreds of them, the settled `item.completed` carries the
// text, and the store already batches them per frame for the chat bubble.
// Every forwarded event is clipped (see shared/clip-runtime-event.ts), so a
// subscriber's memory is bounded by count, not by what a tool returned.
import type { RuntimeEvent } from "../../server/contracts.ts";
import { clipRuntimeEvent } from "../../shared/clip-runtime-event.ts";

export type RuntimeEventListener = (event: RuntimeEvent) => void;

const listeners = new Map<string, Set<RuntimeEventListener>>();

/** Called by the store for every runtime event.  Free when nobody listens. */
export function publishRuntimeEvent(event: RuntimeEvent): void {
  const forThread = listeners.get(event.threadId);
  if (!forThread || forThread.size === 0) return;
  if (event.type === "content.delta") return;
  const clipped = clipRuntimeEvent(event);
  for (const listener of [...forThread]) {
    try {
      listener(clipped);
    } catch (error) {
      // one broken view must not stop the others, or the store's own handling
      console.error("runtime feed: listener threw", error);
    }
  }
}

/** Receive this thread's runtime events until the returned function is called. */
export function subscribeRuntimeEvents(threadId: string, listener: RuntimeEventListener): () => void {
  let forThread = listeners.get(threadId);
  if (!forThread) {
    forThread = new Set();
    listeners.set(threadId, forThread);
  }
  forThread.add(listener);
  return () => {
    const current = listeners.get(threadId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(threadId);
  };
}

const gapListeners = new Set<() => void>();

/** The event stream came back without being able to replay what it missed, so
 *  a subscriber's copy of ANY thread may have a hole.  Free when nobody listens. */
export function publishRuntimeGap(): void {
  for (const listener of [...gapListeners]) {
    try {
      listener();
    } catch (error) {
      console.error("runtime feed: gap listener threw", error);
    }
  }
}

/** Hear about a gap in the stream until the returned function is called. */
export function subscribeRuntimeGap(listener: () => void): () => void {
  gapListeners.add(listener);
  return () => {
    gapListeners.delete(listener);
  };
}

/** How many threads have a subscriber — for tests. */
export const watchedThreadCount = (): number => listeners.size;

/**
 * Collects events and hands them over at most once per `waitMs`, in order.  A
 * running turn can emit dozens of events a second; the view re-renders once
 * per flush, not once per event.  `push` is trailing-edge: the first event of a
 * burst arms the timer, later ones ride along.
 */
export function createEventBatcher(
  flush: (events: RuntimeEvent[]) => void,
  waitMs = 250,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
) {
  let pending: RuntimeEvent[] = [];
  let handle: unknown = null;
  const run = () => {
    handle = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    flush(batch);
  };
  return {
    push(event: RuntimeEvent) {
      pending.push(event);
      if (handle === null) handle = schedule(run, waitMs);
    },
    /** Deliver what is pending now (a turn just settled). */
    flushNow() {
      if (handle !== null) cancel(handle);
      run();
    },
    /** Drop what is pending and stop the timer (the view went away). */
    dispose() {
      if (handle !== null) cancel(handle);
      handle = null;
      pending = [];
    },
    pendingCount: () => pending.length,
  };
}
