import { useEffect, useRef } from "react";

/** Runs `dismiss` once for each pick the store counts, and for nothing else.
 *
 *  The Fleet Matrix overview covers the chat pane, so it has to give way when
 *  the person opens a bot or a room from anywhere: the sidebar, ⌘1–9, the
 *  command palette, a notification.  The store's `selectionNonce` moves on
 *  exactly those picks, including a click on the chat that is already open.
 *  Anything the store changes by itself (a streamed bot or room update, a
 *  thread pin, the hydrate that first selects the first bot) leaves it alone,
 *  so none of that may close the overview.
 *
 *  The first value seen is the baseline, not a pick: mounting never dismisses.
 *  `dismiss` can change identity every render; the guard on the stored nonce
 *  keeps a re-run from firing it twice. */
export function useDismissOnSelection(selectionNonce: number, dismiss: () => void): void {
  const seen = useRef(selectionNonce);
  useEffect(() => {
    if (seen.current === selectionNonce) return;
    seen.current = selectionNonce;
    dismiss();
  }, [selectionNonce, dismiss]);
}
