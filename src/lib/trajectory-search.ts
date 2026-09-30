// "Search this view", asked from outside it.
//
// The thread header's magnifier and the find shortcut (Cmd/Ctrl+F) belong to
// the chat, which owns the window's key handling.  While the Trajectory tab is
// showing, they should put the caret in ITS search box instead of opening a
// find bar for a conversation that is not on screen.  The tab is a sibling
// component with no ref to hand up, so it listens here.

const listeners = new Set<() => void>();

/** Ask the open Trajectory tab, if any, to focus its search box. */
export function requestTrajectorySearch(): void {
  for (const listener of [...listeners]) listener();
}

/** Answer search requests until the returned function is called. */
export function onTrajectorySearchRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
