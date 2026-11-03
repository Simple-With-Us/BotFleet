// Render counters for BF-2612: how often the chat bodies run while a reply
// streams. `MessagesList` is memo'd and bails, but `ChatView` itself still
// re-executes once per flushed stream frame (the store batches deltas to
// requestAnimationFrame, so at most ~60/s). These counters make that cost
// countable instead of inferred: read them live with
// `window.__chatViewRenderProbe()` in the desktop app, or from tests.
//
// Counting is always on: two integer increments per frame is below noise
// next to one markdown parse, and a probe that needs a rebuild to enable
// never gets enabled during the stream someone wants to measure.

export interface ChatViewRenderSnapshot {
  /** `ChatView` function-body executions since reset. */
  chatViewBody: number;
  /** `MessagesList` function-body executions since reset. */
  messagesListBody: number;
  /** ChatView bodies where the settled list bailed out of rendering. */
  messagesListBails: number;
}

let chatViewBody = 0;
let messagesListBody = 0;

export function recordChatViewBody(): void {
  chatViewBody += 1;
  installChatViewRenderProbe();
}

export function recordMessagesListBody(): void {
  messagesListBody += 1;
}

export function snapshotChatViewRenderProbe(): ChatViewRenderSnapshot {
  return {
    chatViewBody,
    messagesListBody,
    messagesListBails: Math.max(0, chatViewBody - messagesListBody),
  };
}

export function resetChatViewRenderProbe(): void {
  chatViewBody = 0;
  messagesListBody = 0;
}

declare global {
  interface Window {
    __chatViewRenderProbe?: () => ChatViewRenderSnapshot;
    __resetChatViewRenderProbe?: () => void;
  }
}

let installed = false;

/** Exposes the counters on `window` for a live measurement session. */
export function installChatViewRenderProbe(): void {
  if (installed || !("window" in globalThis)) return;
  installed = true;
  window.__chatViewRenderProbe = snapshotChatViewRenderProbe;
  window.__resetChatViewRenderProbe = resetChatViewRenderProbe;
}
