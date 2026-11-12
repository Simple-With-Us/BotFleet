// Which view of a thread the person left it in — Chat or Trajectory — kept per
// thread.  Remembered in memory for the session and in localStorage across
// launches; every storage access is wrapped, because private windows, cleared
// site data and locked-down webviews all reject it, and the switch must still
// work (it just forgets on relaunch).
//
// Only the non-default view is written.  A thread nobody switched has no
// entry, so the map stays small however many threads exist, and it is capped
// on top of that: the oldest entries fall away first.
import { useCallback, useState } from "react";

export type ThreadView = "chat" | "trajectory";

export const THREAD_VIEW_KEY = "botfleet.threadView";
/** Most threads whose view is remembered across launches. */
export const MAX_REMEMBERED_VIEWS = 200;

const DEFAULT_VIEW: ThreadView = "chat";
const isView = (value: unknown): value is ThreadView => value === "chat" || value === "trajectory";

/** This session's answer, so a storage that rejects writes still remembers. */
const session = new Map<string, ThreadView>();

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

/** The stored `{ threadId: view }` map; anything malformed reads as empty. */
export function parseThreadViews(raw: string | null | undefined): Record<string, ThreadView> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, ThreadView> = {};
    for (const [threadId, view] of Object.entries(parsed)) if (isView(view)) out[threadId] = view;
    return out;
  } catch {
    return {};
  }
}

const defaultStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadThreadView(threadId: string, storage?: ReadStorage | null): ThreadView {
  const remembered = session.get(threadId);
  if (remembered) return remembered;
  try {
    const target = storage === undefined ? defaultStorage() : storage;
    return parseThreadViews(target?.getItem(THREAD_VIEW_KEY))[threadId] ?? DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveThreadView(threadId: string, view: ThreadView, storage?: WriteStorage | null): void {
  session.set(threadId, view);
  try {
    const target = storage === undefined ? defaultStorage() : storage;
    if (!target) return;
    const views = parseThreadViews(target.getItem(THREAD_VIEW_KEY));
    // re-insert so the newest choice is last, then drop from the front
    delete views[threadId];
    if (view !== DEFAULT_VIEW) views[threadId] = view;
    const entries = Object.entries(views).slice(-MAX_REMEMBERED_VIEWS);
    target.setItem(THREAD_VIEW_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // the in-memory answer above still holds for this session
  }
}

/** Test seam: forget this session's in-memory answers. */
export function resetThreadViewSession(): void {
  session.clear();
}

/** The open thread's view and a setter.  Switching threads re-reads for the new
 *  one during render, so the old thread's view never flashes into it. */
export function useThreadView(threadId: string): [ThreadView, (view: ThreadView) => void] {
  const [state, setState] = useState(() => ({ threadId, view: loadThreadView(threadId) }));
  let current = state;
  if (state.threadId !== threadId) {
    current = { threadId, view: loadThreadView(threadId) };
    setState(current);
  }
  const choose = useCallback(
    (view: ThreadView) => {
      saveThreadView(threadId, view);
      setState({ threadId, view });
    },
    [threadId],
  );
  return [current.view, choose];
}
